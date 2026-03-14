import dotenv from 'dotenv';
import path from 'path';
import { argv } from 'yargs';

dotenv.config({ path: path.resolve(__dirname, '../../.env.bots') });
import { BotIdentityGenerator } from './bot-identity-generator';
import { BotContext } from './botContext';
import { AircraftTypeAllocator } from './helper/aircraft-type-allocator';

const urls = {
    local: "ws://127.0.0.1:3501/ffa",
    euFfa1: "wss://eu.airmash.online/ffa1",
    euFfa2: "wss://eu.airmash.online/ffa2",
    euCtf: "wss://lags.win/ctf",
    usFfa: "wss://game.airmash.steamroller.tk/ffa",
    usCtf1: "wss://game.airmash.steamroller.tk/ctf",
    usCtf2: "wss://airmash.xyz/ctf1"
};

let ws = argv.ws as string;
if (ws && !ws.startsWith('ws') && !ws.startsWith('http')) {
    ws = urls[ws];
}
ws = ws || urls.euFfa1;

const flagConfig = process.env.BOTS_FLAG || argv.flag as string || "random";
const typeConfig = process.env.BOTS_TYPE || argv.type as string || "random";
const characterConfig = process.env.BOTS_CHARACTER || argv.character as string;
const isSecondaryTeamCoordinator = !!argv.noTeamCoordinator;
const numBots = parseInt(process.env.NUM_BOTS, 10) || (argv.num as number) || 1;
const keepBots = !!argv.keep;
const isDevelopment = !!argv.dev;
const logLevel = process.env.BOTS_LOG_LEVEL || argv.level as string || "warn";
const noIdle = !!argv.noIdle || process.env.BOTS_NO_IDLE === 'true';

const allocator = new AircraftTypeAllocator(ws);
const identityGenerator = new BotIdentityGenerator(flagConfig, typeConfig, argv.name as string, allocator);

// start with one bot, it will spawn new bots as needed.
const context = new BotContext(ws, identityGenerator, characterConfig, isSecondaryTeamCoordinator, isDevelopment, logLevel, 0, numBots, keepBots, noIdle, allocator, typeConfig);
context.startBot();
