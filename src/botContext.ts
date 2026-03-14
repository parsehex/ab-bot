import { IAirmashEnvironment } from "./bot/airmash/iairmash-environment";
import { BotCharacter } from "./bot/bot-character";
import { Logger } from "./helper/logger";
import { AirmashBot } from "./bot/airmash-bot";
import { TimeoutManager } from "./helper/timeoutManager";
import { AirmashApiFacade } from "./bot/airmash/airmash-api";
import { StopWatch } from "./helper/timer";
import { BotIdentityGenerator } from "./bot-identity-generator";
import { BotSpawner } from "./bot-spawner";
import { AircraftTypeAllocator } from "./helper/aircraft-type-allocator";
import { BotIdentity } from "./bot-identity";

const MAX_RESTART_TRIES = 3;

export class BotContext {
    env: IAirmashEnvironment;
    bot: AirmashBot;
    tm = new TimeoutManager();
    logger: Logger;
    character: BotCharacter;

    private lastRestartTimer = new StopWatch();
    private restartCount = 0;
    private spawner: BotSpawner;
    private identity: BotIdentity;

    constructor(
        public websocketUrl: string,
        public identityGenerator: BotIdentityGenerator,
        public characterConfig: string,
        public isSecondaryTeamCoordinator: boolean,
        public isDevelopment: boolean,
        public logLevel: string,
        public botIndex: number,
        numBots: number = null,
        keepBots: boolean = false,
        public noIdle = false,
        public allocator: AircraftTypeAllocator = null,
        public originalTypeConfig: string = null,
        predefinedIdentity: BotIdentity = null) {

        this.identity = predefinedIdentity;

        if (botIndex === 0) {
            // this is the first bot, which should manage the number of bots
            this.spawner = new BotSpawner(this, numBots, keepBots);
        }
    }

    startBot() {
        this.startBotInner();
    }

    killBot() {
        this.env.stop();
        this.tm.clearAll();
        if (this.bot) {
            this.bot.stop();
        }
    }

    rebootBot() {
        this.killBot();
        this.logger.info("Restarting bot in a few seconds.");

        if (this.lastRestartTimer.elapsedMinutes() < 1) {
            this.restartCount++;
            if (this.restartCount > MAX_RESTART_TRIES) {
                // give up
                if (this.logger) {
                    this.logger.error("Too many restart tries; giving up.")
                }
                return;
            }
        } else {
            this.restartCount = 0;
        }

        this.tm.setTimeout(() => this.startBotInner(), 4000);
    }

    private startBotInner() {
        if (!this.identity) {
            this.identity = this.identityGenerator.generateIdentity(this.botIndex);
        }

        const identity = this.identity;
        this.character = BotCharacter[this.characterConfig] || BotCharacter.get(identity.aircraftType);

        if (!this.logger) {
            this.logger = new Logger(this.botIndex, identity.name, this.isDevelopment, this.logLevel);
        }

        this.logger.info('Starting:', {
            type: identity.aircraftType,
            flag: identity.flag,
            character: this.character.name,
            url: this.websocketUrl,
        });

        this.lastRestartTimer.start();

        this.env = new AirmashApiFacade(this.websocketUrl, this.logger, this.tm);
        this.env.start();

        if (this.botIndex === 0) {
            // Coordinator bot: connects to server for state monitoring but doesn't join as a player
            this.logger.info('Running as coordinator (monitoring only, not playing)');
            if (this.spawner) {
                this.spawner.start();
            }
        } else {
            // Worker bot: normal gameplay
            this.bot = new AirmashBot(this, this.isSecondaryTeamCoordinator);
            const timeOutMs = this.botIndex * 500;
            this.tm.setTimeout(() => this.bot.join(identity.name, identity.flag, identity.aircraftType), timeOutMs);
        }
    }

    spawnNewChildBot(botIndex: number): BotContext {
        const context = new BotContext(this.websocketUrl, this.identityGenerator, this.characterConfig,
            this.isSecondaryTeamCoordinator, this.isDevelopment, this.logLevel, botIndex, undefined, undefined, this.noIdle);
        context.startBot();
        return context;
    }


}
