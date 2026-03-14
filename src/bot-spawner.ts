import { BotContext } from "./botContext";
import { StopWatch } from "./helper/timer";
import { PlayerInfo } from "./bot/airmash/player-info";
import { Worker } from 'worker_threads';
import path from 'path';

const NUM_BOTS_EVALUATION_INTERVAL_MINUTES = 0.5;
const NEED_FOR_BOTS_EVALUATION_INTERVAL_SECONDS = 1;

export class BotSpawner {
    private children: Worker[] = [];
    private evaluateNumBotsTimer = new StopWatch();
    private evaluateNeedForBotsTimer = new StopWatch();
    private maxNumBots: number;
    private isFirstTime: boolean;

    constructor(private context: BotContext, numBots: number, private keepBots) {
        this.maxNumBots = numBots;
        this.isFirstTime = true;
    }

    start() {
        this.context.env.on("tick", () => this.onTick());
        this.evaluateNumBotsTimer.start();
        this.evaluateNeedForBotsTimer.start();
    }

    onTick(): any {
        this.evaluateNumBots();
        this.evaluateNeedForBots();
    }

    private evaluateNeedForBots() {
        if (this.evaluateNeedForBotsTimer.elapsedSeconds() < NEED_FOR_BOTS_EVALUATION_INTERVAL_SECONDS) {
            return;
        }

        this.evaluateNeedForBotsTimer.start();

        // With workers, we might not have direct access to all bot IDs easily
        // without messaging. For now, let's keep the logic simple.
        // The main bot and its children are all bots.
        const allPlayers = this.context.env.getPlayers();
        const numActivePlayers = allPlayers.filter(x =>
            !x.name.endsWith('_') // Assume bots have '_' suffix
            && (!x.isHidden || x.isDead)
            && PlayerInfo.isActive(x)
        ).length;

        const canPause = this.context.noIdle ? false : (numActivePlayers === 0);
        // We'd need to message workers to pause them if they were fully independent,
        // but they listen to the same server state, so they can determine this themselves
        // if we pass the noIdle config.
        this.context.bot.canPause = canPause;
    }

    private evaluateNumBots() {

        if (!this.isFirstTime && this.evaluateNumBotsTimer.elapsedMinutes() < NUM_BOTS_EVALUATION_INTERVAL_MINUTES) {
            return;
        }

        this.evaluateNumBotsTimer.start();

        this.isFirstTime = false;

        const numPlayers = this.context.env.getPlayers().length;
        const maxNumPlayersWithBots = this.maxNumBots * 2;

        const totalBotsRequired = Math.min(maxNumPlayersWithBots - numPlayers, this.maxNumBots);
        const numBots = this.children.length;

        if (totalBotsRequired > 0) {
            const botsToAdd = totalBotsRequired - numBots;
            if (botsToAdd > 0) {
                let botIndex = this.context.botIndex;
                this.context.logger.warn("Adding " + botsToAdd + " new bots via Worker Threads");
                for (let i = 0; i < botsToAdd; i++) {
                    botIndex++;

                    const currentBotIndex = botIndex;
                    const predefinedIdentity = this.context.identityGenerator.generateIdentity(currentBotIndex);

                    const worker = new Worker(path.resolve(__dirname, './worker.js'), {
                        workerData: {
                            websocketUrl: this.context.websocketUrl,
                            characterConfig: this.context.characterConfig,
                            isSecondaryTeamCoordinator: this.context.isSecondaryTeamCoordinator,
                            isDevelopment: this.context.isDevelopment,
                            logLevel: this.context.logLevel,
                            botIndex: currentBotIndex,
                            noIdle: this.context.noIdle,
                            predefinedIdentity,
                            flagConfig: this.context.identityGenerator.flagConfig,
                            typeConfig: this.context.originalTypeConfig
                        }
                    });

                    worker.on('message', (msg) => {
                        if (msg.type === 'error') {
                            this.context.logger.error(`Worker startup error (botIndex ${currentBotIndex}): ${msg.error}`, msg.stack);
                        }
                    });

                    worker.on('error', (err) => {
                        this.context.logger.error(`Worker error (botIndex ${currentBotIndex}):`, err);
                    });

                    worker.on('exit', (code) => {
                        if (code !== 0) {
                            this.context.logger.error(`Worker stopped with exit code ${code}`);
                        }
                    });

                    this.children.push(worker);
                }
            }
        } else if (totalBotsRequired < 0) {
            const botsToRemove = Math.min(Math.abs(totalBotsRequired), numBots - 1); // can't remove myself

            if (botsToRemove > 0 && !this.keepBots) {
                this.context.logger.warn("Removing " + botsToRemove + " bots");

                const killedWorkers = [];
                for (let i = 0; i < botsToRemove; i++) {
                    this.children[i].postMessage('stop');
                    killedWorkers.push(this.children[i]);
                }
                this.children = this.children.filter(x => killedWorkers.indexOf(x) === -1);
            }
        }
    }
}
