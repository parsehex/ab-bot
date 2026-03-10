import { parentPort, workerData } from 'worker_threads';
import { BotContext } from './botContext';
import { BotIdentityGenerator } from './bot-identity-generator';
import path from 'path';
import dotenv from 'dotenv';

if (!parentPort) {
    throw new Error('This file must be run as a worker thread');
}

try {
    const {
        websocketUrl,
        flagConfig,
        typeConfig,
        characterConfig,
        isSecondaryTeamCoordinator,
        isDevelopment,
        logLevel,
        botIndex,
        noIdle
    } = workerData;

    // Load env if needed, although mostly passed via workerData
    dotenv.config({ path: path.resolve(__dirname, '../../.env.bots') });

    const identityGenerator = new BotIdentityGenerator(flagConfig, typeConfig, undefined);
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
        noIdle
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
