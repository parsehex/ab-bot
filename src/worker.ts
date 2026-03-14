import { parentPort, workerData } from 'worker_threads';
import { BotContext } from './botContext';
import { BotIdentityGenerator } from './bot-identity-generator';
import path from 'path';
import dotenv from 'dotenv';
import { AircraftTypeAllocator } from './helper/aircraft-type-allocator';

if (!parentPort) {
    throw new Error('This file must be run as a worker thread');
}

try {
    const {
        websocketUrl,
        characterConfig,
        isSecondaryTeamCoordinator,
        isDevelopment,
        logLevel,
        botIndex,
        noIdle,
        predefinedIdentity,
        flagConfig,
        typeConfig
    } = workerData;

    // Load env if needed, although mostly passed via workerData
    dotenv.config({ path: path.resolve(__dirname, '../../.env.bots') });

    const allocator = new AircraftTypeAllocator(websocketUrl);
    const identityGenerator = new BotIdentityGenerator(flagConfig, typeConfig, null, allocator);

    const context = new BotContext(
        websocketUrl,
        identityGenerator,
        characterConfig,
        isSecondaryTeamCoordinator,
        isDevelopment,
        logLevel,
        botIndex,
        null,
        false,
        noIdle,
        allocator,
        typeConfig,
        predefinedIdentity
    );

    context.startBot();

    parentPort.on('message', (message) => {
        if (message === 'stop') {
            context.killBot();
            process.exit(0);
        }
    });
} catch (err) {
    if (parentPort) {
        parentPort.postMessage({ type: 'error', error: err.message, stack: err.stack });
    }
    process.exit(1);
}
