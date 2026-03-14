import { Calculations } from './bot/calculations';
import { BotIdentity } from './bot-identity';
import { AircraftTypeAllocator } from './helper/aircraft-type-allocator';


// const flagCodes = ['communist', 'imperial', 'rainbow', 'jolly', 'nl', 'be', 'de', 'fr', 'cz', 'fi',
//     'hu', 'lv', 'lt', 'md', 'pt', 'ro', 'rs', 'sk', 'ch', 'tr', 'ua', 'gb', 'al', 'at', 'ba', 'by', 'bg',
//     'hr', 'cy', 'dk', 'ee', 'gr', 'is', 'il', 'it', 'mk', 'no', 'pl', 'ru', 'si', 'es', 'se'];

const localesForFlag = {
    au: 'en_AU',
    ca: 'en_CA',
    nl: 'nl',
    be: 'nl',
    de: 'de',
    fr: 'fr',
    // cz: 'cz',
    pt: 'pt_BR',
    // sk: 'sk',
    ch: 'de_CH',
    // tr: 'tr',
    gb: 'en_GB',
    at: 'de_AT',
    it: 'it',
    no: 'nb_NO',
    // pl: 'pl',
    // ru: 'ru',
    es: 'es',
    se: 'sv',
    us: 'en_US',
    // communist: 'zh_CN',
    // imperial: 'ja'
};
const flagCodes = Object.keys(localesForFlag);

export class BotIdentityGenerator {

    private usedNames = new Set<string>();

    constructor(public flagConfig: string,
        public planeTypeConfig: string,
        private nameConfig: string,
        private allocator?: AircraftTypeAllocator) {
    }

    generateIdentity(botIndex: number): BotIdentity {
        let aircraftType: number;
        let flag: string;

        if (this.flagConfig === 'random') {
            flag = flagCodes[Calculations.getRandomInt(0, flagCodes.length)];
        } else {
            flag = this.flagConfig;
        }

        if (this.planeTypeConfig === 'random') {
            aircraftType = Calculations.getRandomInt(1, 6);
        } else if ((this.planeTypeConfig === 'distribute' || this.planeTypeConfig === 'd') && this.allocator) {
            aircraftType = Number(this.allocator.getNextType(this.planeTypeConfig));
        } else {
            aircraftType = Number(this.planeTypeConfig) || 1;
        }

        let lang = localesForFlag[flag];
        if (!lang) {
            lang = localesForFlag[flagCodes[Calculations.getRandomInt(0, flagCodes.length)]];
        }

        const x = require('faker/locale/' + lang);

        let name: string;
        if (this.nameConfig) {
            name = botIndex === 0 ? this.nameConfig : `${this.nameConfig}-${botIndex}`;
        } else {
            // Ensure variety and uniqueness when using faker
            let attempts = 0;
            do {
                name = x.name.firstName() + "_";
                attempts++;
            } while (this.usedNames.has(name) && attempts < 10);

            if (this.usedNames.has(name)) {
                name = name + botIndex;
            }
        }

        this.usedNames.add(name);

        return {
            name,
            aircraftType,
            flag
        };
    }

}
