import { ITargetSelection } from "./itarget-selection";
import { IAirmashEnvironment } from "../airmash/iairmash-environment";
import { BotCharacter } from "../bot-character";
import { ITarget } from "../targets/itarget";
import { FlagInfo } from "../../api/flagInfo";
import { Calculations } from "../calculations";
import { Pos } from "../pos";
import { DoNothingTarget } from "../targets/do-nothing.target";
import { DodgeMissileTarget } from "../targets/dodge-missile-target";
import { GotoLocationTarget } from "../targets/goto-location-target";
import { OtherPlayerTarget } from "../targets/other-player-target";
import { ProtectTarget } from "../targets/protect-target";
import { StopWatch } from "../../helper/timer";
import { CrateTarget } from "../targets/crate-target";
import { BringFlagHomeTarget } from "../targets/bring-flag-home-target";
import { FlagHelpers } from "../../helper/flaghelpers";
import { Logger } from "../../helper/logger";
import { Slave } from "../../teamcoordination/slave";
import { TOO_FAR_AWAY_FOR_POOPING_FLAG, HandOverFlagTarget } from "../targets/hand-over-flag-target";
import { BotContext } from "../../botContext";
import { PlayerInfo } from "../airmash/player-info";
import { MeetTarget } from "../targets/meet-target";

enum FlagStates {
    Unknown = "Unkown",
    ImCarrier = "I'm the flag carrier",
    ImCarrierInDangerZone = "I just grabbed the flag, still in enemy base",
    MyFlagTaken = "My flag is taken",
    MyFlagDisplaced = "My flag is displaced",
    OtherFlagTaken = "The other flag is taken",
    AllIsPeaceful = "Calm before the storm"
}

const blueFlagPositions = {
    defaultPos: new Pos({ x: -9670, y: -1470 }),
    safeLines: { x: -7813, y: -505 }
};

const redFlagPositions = {
    defaultPos: new Pos({ x: 8600, y: -940 }),
    safeLines: { x: 6902, y: 6 }
};

const REEVALUATION_TIME_MS = 1500;
const CRATE_DISTANCE_THRESHOLD = 500;
const FIGHT_DISTANCE_THRESHOLD = 300;
const ATTACKER_FIGHT_DISTANCE_THRESHOLD = 1500;
const PROTECT_FLAG_DISTANCE = 700;
const PROTECT_PLAYER_DISTANCE = 10;
const ENEMY_BASE_HANDOFF_BLOCK_RADIUS = 1700;
const HANDOFF_RETRY_COOLDOWN_MS = 5000;

export class CtfTargetSelection implements ITargetSelection {

    // cached state
    private myId: number;
    private myFlagInfo: FlagInfo;
    private otherFlagInfo: FlagInfo;
    private myTeam: number;
    private otherTeam: number;
    private flagState: FlagStates;
    private defaultMyFlagPos: Pos;
    private defaultOtherFlagPos: Pos;

    // real state
    private myRole: string;
    private targets: ITarget[] = [];
    private lastLog: string;
    private stopwatch = new StopWatch();
    private distanceToMyFlag: number;
    private distanceToOtherFlag: number;
    private playerKilledSubscription: number;
    private isAutoMode: boolean = true;

    // Goliath stuck detection
    private lastStuckCheckPos: Pos;
    private stuckStopwatch = new StopWatch();

    // Non-bot flag handoff
    private flagOfferPlayerId: number = null;
    private flagOfferChatStopwatch = new StopWatch();
    private flagOfferOnTopStopwatch = new StopWatch();
    private lastHandoffTargetId: number = null;
    private lastHandoffAttemptAtMs = 0;

    private get env(): IAirmashEnvironment {
        return this.context.env;
    }

    private get logger(): Logger {
        return this.context.logger;
    }

    private get character(): BotCharacter {
        return this.context.character;
    }


    constructor(private context: BotContext, private slave: Slave) {
        this.reset();
        this.playerKilledSubscription = this.env.on('playerkilled', (x) => this.onPlayerKilled(x));
    }

    reset(): void {
        this.clearAllTargets();
        this.lastLog = null;
        this.stopwatch.start();

        this.flagOfferPlayerId = null;
        this.flagOfferChatStopwatch.start();
        this.flagOfferOnTopStopwatch.start();
        this.lastHandoffTargetId = null;
        this.lastHandoffAttemptAtMs = 0;

        this.slave.repeatLastCommand();
    }

    dispose(): void {
        this.env.off('playerkilled', this.playerKilledSubscription);
    }

    exec(): ITarget {

        this.updateFlagInfo();
        const flagstate = this.determineFlagState();

        if (flagstate !== this.flagState) {
            this.logger.info("Most urgent flagstate: " + flagstate);
            this.flagState = flagstate;
        }

        this.updateTargetStack();

        this.logState();

        const activeTarget = this.peek();
        if (!activeTarget) {
            this.logger.warn("No active target in CTF, using DoNothingTarget");
            return new DoNothingTarget();
        }
        activeTarget.isActive = true;
        return activeTarget;
    }

    private peek(): ITarget {
        if (this.targets.length === 0) {
            return null;
        }
        return this.targets[this.targets.length - 1];
    }

    private removeStaleTargetsFromStack() {

        const invalidTargets: ITarget[] = [];
        for (let i = 0; i < this.targets.length; i++) {
            const t = this.targets[i];
            if (!t.isValid()) {
                invalidTargets.push(t);
            }
        }
        this.targets = this.targets.filter(x => invalidTargets.indexOf(x) === -1);

    }

    private updateTargetStack(): void {
        // dodging always goes first
        const dodge = new DodgeMissileTarget(this.env, this.character, []);
        if (dodge.isValid()) {
            this.targets.push(dodge);
            return;
        }

        this.removeStaleTargetsFromStack();

        if (this.flagState !== FlagStates.ImCarrierInDangerZone) {
            // take crates nearby
            const crate = new CrateTarget(this.env, this.logger, []);
            crate.setMaxDistance(CRATE_DISTANCE_THRESHOLD);
            if (crate.isValid()) {
                this.targets.push(crate);
                return;
            }

            // attack enemies nearby
            if (this.myRole === "A") {
                const fight = new OtherPlayerTarget(this.env, this.logger, this.character, []);

                fight.setMaxDistance(FIGHT_DISTANCE_THRESHOLD);
                if (fight.isValid()) {
                    this.targets.push(fight);
                    return;
                }
            }
        }

        const currentTargetIsOK = this.peek() && this.peek().isValid();
        const shouldReevaluateTarget = this.stopwatch.elapsedMs() > REEVALUATION_TIME_MS || !currentTargetIsOK;

        if (!shouldReevaluateTarget) {
            return;
        }

        if (this.peek() && this.peek().isSticky) {
            // sticky target on top, don't reevaluate
            return;
        }

        const target = this.determineTarget();
        if (currentTargetIsOK) {
            // only replace it if it is a different target
            if (!target.equals(this.peek())) {
                this.targets.push(target);
            }
        } else {
            this.targets.push(target);
        }

        this.stopwatch.start();
    }

    private logState(): void {

        const info = this.peek().getInfo();
        if (info.info !== this.lastLog) {
            this.logger.info("CTF target: " + info.info);
            this.lastLog = info.info;
        }
    }

    private determineTarget(): ITarget {

        if (this.flagState === FlagStates.Unknown) {
            return new DoNothingTarget();
        }

        const doDefensiveActions = this.myRole === "D" || this.distanceToMyFlag < this.distanceToOtherFlag;

        // Goliath should move to meet teammate with flag for handoff
        const me = this.env.me();
        if (me.type === 2) {
            const flagInfo = this.env.getFlagInfo(this.otherTeam);
            if (flagInfo && flagInfo.carrierId && flagInfo.carrierId !== -1) {
                const carrier = this.env.getPlayer(flagInfo.carrierId);
                if (carrier && carrier.team === this.myTeam && carrier.type !== 2) {
                    // Check if I'm the closest goliath to the carrier
                    const allGoliaths = this.env.getPlayers().filter(p => 
                        p.team === this.myTeam && p.type === 2 && p.id !== this.myId && PlayerInfo.isActive(p)
                    );
                    
                    let isClosestGoli = true;
                    if (allGoliaths.length > 0) {
                        const myDistToCarrier = this.getDistance(PlayerInfo.getMostReliablePos(carrier), me.pos);
                        for (const goli of allGoliaths) {
                            const goliDistToCarrier = this.getDistance(PlayerInfo.getMostReliablePos(carrier), PlayerInfo.getMostReliablePos(goli));
                            if (goliDistToCarrier < myDistToCarrier) {
                                isClosestGoli = false;
                                break;
                            }
                        }
                    }

                    if (isClosestGoli) {
                        // I'm the closest goli - move to meet carrier without distance limit
                        const meetTarget = new MeetTarget(this.env, this.logger, carrier.id);
                        meetTarget.setInfo(`gathering with flag carrier ${carrier.name}`);
                        return meetTarget;
                    } else {
                        // I'm not the closest - go to enemy base for potential re-grab
                        const goToEnemyBase = new GotoLocationTarget(this.env, this.logger, this.defaultOtherFlagPos);
                        goToEnemyBase.setInfo("heading to enemy base for re-grab");
                        return goToEnemyBase;
                    }
                }
            }
        }

        if (this.flagState === FlagStates.ImCarrier || this.flagState === FlagStates.ImCarrierInDangerZone) {
            const meInfo = this.env.me();
            const myPos = meInfo.pos;
            const distToEnemyBase = this.getDistance(myPos, this.defaultOtherFlagPos);
            const nearEnemyBase =
                this.flagState === FlagStates.ImCarrierInDangerZone ||
                distToEnemyBase < ENEMY_BASE_HANDOFF_BLOCK_RADIUS;

            let proactiveHandoffLowHealthThreshold = 0.25;
            if (meInfo.type === 2) {
                proactiveHandoffLowHealthThreshold = 1 / 3;
            }
            const urgentHandoffNeeded =
                meInfo.hasShield || meInfo.health <= proactiveHandoffLowHealthThreshold;
            const allowProactiveHandoff = !nearEnemyBase || urgentHandoffNeeded;

            if (this.env.me().type !== 2) {
                const goliaths = this.env.getPlayers().filter(p => p.team === this.myTeam && p.type === 2 && p.id !== this.myId && PlayerInfo.isActive(p));
                if (goliaths.length > 0) {
                    goliaths.sort((a, b) => {
                        const distA = this.getDistance(PlayerInfo.getMostReliablePos(a), this.env.me().pos);
                        const distB = this.getDistance(PlayerInfo.getMostReliablePos(b), this.env.me().pos);
                        return distA - distB;
                    });

                    const closestGoliath = goliaths[0];
                    const distToGoli = this.getDistance(PlayerInfo.getMostReliablePos(closestGoliath), this.env.me().pos);

                    if (allowProactiveHandoff && distToGoli < 400) {
                        const target = new HandOverFlagTarget(this.env, this.logger, closestGoliath.id, true);
                        return target;
                    } else if (allowProactiveHandoff && distToGoli < 1000) {
                        // Move toward closest goli if they're within reasonable range but not immediate handoff distance
                        // But check safety first
                        const myPos = this.env.me().pos;
                        const enemies = this.env.getPlayers().filter(p => p.team !== this.myTeam && PlayerInfo.isActive(p) && !p.isHidden);
                        let isSafe = true;

                        if (enemies.length > 0) {
                            enemies.sort((a, b) => {
                                const distA = this.getDistance(PlayerInfo.getMostReliablePos(a), myPos);
                                const distB = this.getDistance(PlayerInfo.getMostReliablePos(b), myPos);
                                return distA - distB;
                            });

                            const closestEnemyDist = this.getDistance(PlayerInfo.getMostReliablePos(enemies[0]), myPos);
                            if (closestEnemyDist < 800) {
                                isSafe = false;
                            }
                        }

                        if (isSafe) {
                            const meetTarget = new MeetTarget(this.env, this.logger, closestGoliath.id);
                            meetTarget.setInfo(`moving toward goliath ${closestGoliath.name} for handoff`);
                            return meetTarget;
                        }
                    }
                }

                // Flag handoff to teammates
                const meType = this.env.me().type;
                const myPos = this.env.me().pos;

                let receivers = this.env.getPlayers().filter(p => {
                    if (p.team !== this.myTeam || p.id === this.myId || !PlayerInfo.isActive(p)) return false;

                    if (meType === 3) {
                        if (p.type === 3 && p.name.endsWith("_")) return false;
                        return true;
                    } else {
                        // Non-(heli or non-goliath) bots only drop to humans
                        return !p.name.endsWith("_");
                    }
                });

                if (receivers.length > 0) {
                    receivers.sort((a, b) => {
                        const getScore = (p: PlayerInfo) => {
                            const isHuman = !p.name.endsWith("_");
                            if (isHuman && p.type !== 3) return 1; // Human non-heli
                            if (!isHuman && p.type !== 3) return 2; // Bot non-heli
                            if (isHuman && p.type === 3) return 3; // Human heli
                            return 4; // Backup
                        };

                        const scoreA = getScore(a);
                        const scoreB = getScore(b);
                        if (scoreA !== scoreB) return scoreA - scoreB;

                        const distA = this.getDistance(PlayerInfo.getMostReliablePos(a), myPos);
                        const distB = this.getDistance(PlayerInfo.getMostReliablePos(b), myPos);
                        return distA - distB;
                    });

                    const bestReceiver = receivers[0];
                    const distToReceiver = this.getDistance(PlayerInfo.getMostReliablePos(bestReceiver), myPos);
                    const isRetryingSameReceiverTooSoon =
                        this.lastHandoffTargetId === bestReceiver.id &&
                        Date.now() - this.lastHandoffAttemptAtMs < HANDOFF_RETRY_COOLDOWN_MS;

                    if (allowProactiveHandoff && !isRetryingSameReceiverTooSoon && distToReceiver < 400) {
                        // Check if enemies are nearby
                        const enemies = this.env.getPlayers().filter(p => p.team !== this.myTeam && PlayerInfo.isActive(p) && !p.isHidden);
                        let isSafe = true;

                        if (enemies.length > 0) {
                            enemies.sort((a, b) => {
                                const distA = this.getDistance(PlayerInfo.getMostReliablePos(a), myPos);
                                const distB = this.getDistance(PlayerInfo.getMostReliablePos(b), myPos);
                                return distA - distB;
                            });

                            const closestEnemyDist = this.getDistance(PlayerInfo.getMostReliablePos(enemies[0]), myPos);
                            if (closestEnemyDist < 800) {
                                isSafe = false;
                            }
                        }

                        if (isSafe) {
                            if (this.flagOfferPlayerId !== bestReceiver.id) {
                                this.flagOfferPlayerId = bestReceiver.id;
                                this.flagOfferChatStopwatch.start();
                                this.flagOfferOnTopStopwatch.start();
                            }

                            if (this.flagOfferChatStopwatch.elapsedSeconds() > 10) {
                                this.env.sendChat(`Hey ${bestReceiver.name}, want the flag? Come here`, false);
                                this.flagOfferChatStopwatch.start();
                            }

                            if (distToReceiver < 120) {
                                if (this.flagOfferOnTopStopwatch.elapsedSeconds() > 1) {
                                    this.logger.info(`Handing flag over to teammate ${bestReceiver.name}`);
                                    const target = new HandOverFlagTarget(this.env, this.logger, bestReceiver.id, true);
                                    target.isSticky = true;
                                    this.lastHandoffTargetId = bestReceiver.id;
                                    this.lastHandoffAttemptAtMs = Date.now();

                                    this.flagOfferPlayerId = null;
                                    this.flagOfferOnTopStopwatch.start();

                                    return target;
                                }
                            } else {
                                this.flagOfferOnTopStopwatch.start();
                            }
                        } else {
                            this.flagOfferPlayerId = null;
                        }
                    } else {
                        this.flagOfferPlayerId = null;
                    }
                } else {
                    this.flagOfferPlayerId = null;
                }
            } else {
                // I am a goliath with the flag
                const myPos = this.env.me().pos;

                if (!this.lastStuckCheckPos) {
                    this.lastStuckCheckPos = new Pos(myPos);
                    this.stuckStopwatch.start();
                }

                const stuckThresholdSecs = myPos.y > 0 ? 2 : 4;
                if (this.stuckStopwatch.elapsedSeconds() > stuckThresholdSecs) {
                    const distMoved = Calculations.getDelta(this.lastStuckCheckPos, myPos).distance;
                    if (distMoved < 150) {
                        // Goliath is stuck!
                        // Is anyone standing on me? (within < 100 units)
                        const teammates = this.env.getPlayers().filter(p => p.team === this.myTeam && p.id !== this.myId && PlayerInfo.isActive(p));
                        teammates.sort((a, b) => {
                            const distA = this.getDistance(PlayerInfo.getMostReliablePos(a), myPos);
                            const distB = this.getDistance(PlayerInfo.getMostReliablePos(b), myPos);
                            return distA - distB;
                        });

                        if (teammates.length > 0) {
                            const closestTeammate = teammates[0];
                            const distToTeammate = this.getDistance(PlayerInfo.getMostReliablePos(closestTeammate), myPos);
                            if (distToTeammate < 100) {
                                const target = new HandOverFlagTarget(this.env, this.logger, closestTeammate.id, true);
                                target.isSticky = true;
                                this.logger.info("Stuck, handover to " + closestTeammate.name);
                                this.lastHandoffTargetId = closestTeammate.id;
                                this.lastHandoffAttemptAtMs = Date.now();

                                // Reset the tracker so we don't spam if they drop and re-grab
                                this.lastStuckCheckPos = new Pos(myPos);
                                this.stuckStopwatch.start();

                                return target;
                            }
                        }
                    }

                    // Reset interval
                    this.lastStuckCheckPos = new Pos(myPos);
                    this.stuckStopwatch.start();
                }
            }

            // Shield handoff
            if (meInfo.hasShield) {
                const teammates = this.env.getPlayers().filter(p => p.team === this.myTeam && p.id !== this.myId && PlayerInfo.isActive(p));
                if (teammates.length > 0) {
                    teammates.sort((a, b) => {
                        const distA = this.getDistance(PlayerInfo.getMostReliablePos(a), myPos);
                        const distB = this.getDistance(PlayerInfo.getMostReliablePos(b), myPos);
                        return distA - distB;
                    });
                    const closestTeammate = teammates[0];
                    if (this.getDistance(PlayerInfo.getMostReliablePos(closestTeammate), myPos) < 40) {
                        const target = new HandOverFlagTarget(this.env, this.logger, closestTeammate.id, true);
                        target.isSticky = true;
                        this.lastHandoffTargetId = closestTeammate.id;
                        this.lastHandoffAttemptAtMs = Date.now();
                        return target;
                    }
                }
            }

            // Low health handoff
            let lowHealthThreshold = 0.25;
            let checkSafe = false;
            if (meInfo.type === 2) { // Goli
                lowHealthThreshold = 1 / 3;
                checkSafe = true;
            }

            if (meInfo.health <= lowHealthThreshold) {
                let shouldPass = true;
                if (checkSafe) {
                    // Check if enemies are nearby
                    const enemies = this.env.getPlayers().filter(p => p.team !== this.myTeam && PlayerInfo.isActive(p) && !p.isHidden);
                    if (enemies.length > 0) {
                        enemies.sort((a, b) => {
                            const distA = this.getDistance(PlayerInfo.getMostReliablePos(a), myPos);
                            const distB = this.getDistance(PlayerInfo.getMostReliablePos(b), myPos);
                            return distA - distB;
                        });

                        const closestEnemyDist = this.getDistance(PlayerInfo.getMostReliablePos(enemies[0]), myPos);
                        if (closestEnemyDist > 800) {
                            shouldPass = false;
                        }
                    } else {
                        shouldPass = false;
                    }
                }

                if (shouldPass) {
                    const teammates = this.env.getPlayers().filter(p => p.team === this.myTeam && p.id !== this.myId && PlayerInfo.isActive(p) && p.health > 0.6);

                    if (teammates.length > 0) {
                        teammates.sort((a, b) => {
                            const aIsNonBot = !a.name.endsWith("_");
                            const bIsNonBot = !b.name.endsWith("_");

                            if (aIsNonBot && !bIsNonBot) return -1;
                            if (!aIsNonBot && bIsNonBot) return 1;

                            const distA = this.getDistance(PlayerInfo.getMostReliablePos(a), myPos);
                            const distB = this.getDistance(PlayerInfo.getMostReliablePos(b), myPos);
                            return distA - distB;
                        });

                        const closestHealthyTeammate = teammates[0];
                        const distToTeammate = this.getDistance(PlayerInfo.getMostReliablePos(closestHealthyTeammate), myPos);
                        if (distToTeammate < 40) {
                            if (meInfo.health < 0.25) {
                                this.env.sendTeam(`I'm dying, take the flag ${closestHealthyTeammate.name}!`, false);
                            }
                            const target = new HandOverFlagTarget(this.env, this.logger, closestHealthyTeammate.id, true);
                            target.isSticky = true;
                            this.lastHandoffTargetId = closestHealthyTeammate.id;
                            this.lastHandoffAttemptAtMs = Date.now();
                            return target;
                        }
                    }
                }
            }

            const goHome = new BringFlagHomeTarget(this.env, this.logger, this.defaultMyFlagPos, this.flagState === FlagStates.ImCarrierInDangerZone);
            return goHome;
        }

        if (this.flagState === FlagStates.MyFlagTaken && doDefensiveActions) {
            const carrier = this.env.getPlayer(this.myFlagInfo.carrierId);
            if (carrier) {
                const defenders = this.env.getPlayers().filter(p => p.team === this.myTeam && PlayerInfo.isActive(p));
                defenders.sort((a,b) => {
                    const distA = this.getDistance(PlayerInfo.getMostReliablePos(a), PlayerInfo.getMostReliablePos(carrier));
                    const distB = this.getDistance(PlayerInfo.getMostReliablePos(b), PlayerInfo.getMostReliablePos(carrier));
                    return distA - distB;
                });

                const myIndex = defenders.findIndex(p => p.id === this.myId);

                // Let's have roughly 1/3 of the closest defenders try to intercept,
                // but only starting with the 4th closest player (letting 1st - 3rd closest chase)
                const totalDefenders = defenders.length;
                const shouldIntercept = myIndex >= 3 && (myIndex % 3 === 2) && myIndex < totalDefenders;

                if (shouldIntercept) {
                    const carrierPos = PlayerInfo.getMostReliablePos(carrier);
                    const enemyBase = this.defaultOtherFlagPos;

                    // Target a point 75% of the way from the carrier to their base to head them off
                    const interceptPos = new Pos({
                        x: carrierPos.x + (enemyBase.x - carrierPos.x) * 0.75,
                        y: carrierPos.y + (enemyBase.y - carrierPos.y) * 0.75
                    });

                    const interceptTarget = new GotoLocationTarget(this.env, this.logger, interceptPos);
                    interceptTarget.setInfo("Intercept flag carrier");
                    return interceptTarget;
                }
            }

            const killFlagCarrier = new OtherPlayerTarget(this.env, this.logger, this.character, [], this.myFlagInfo.carrierId);
            killFlagCarrier.setInfo("Hunt flag carrier");
            return killFlagCarrier;
        }

        if (this.flagState === FlagStates.MyFlagDisplaced && doDefensiveActions) {
            const recoverFlag = new GotoLocationTarget(this.env, this.logger, this.myFlagInfo.pos);
            recoverFlag.setInfo("recover abandoned flag");
            return recoverFlag;
        }

        if (this.myRole === "A") {
            if (this.flagState === FlagStates.OtherFlagTaken) {
                const carrier = this.env.getPlayer(this.otherFlagInfo.carrierId);

                if (this.env.me().type === 2 && carrier && carrier.type !== 2) {
                    const goliaths = this.env.getPlayers().filter(p => p.team === this.myTeam && p.type === 2 && p.id !== carrier.id && PlayerInfo.isActive(p));
                    goliaths.sort((a,b) => {
                        const distA = this.getDistance(PlayerInfo.getMostReliablePos(a), PlayerInfo.getMostReliablePos(carrier));
                        const distB = this.getDistance(PlayerInfo.getMostReliablePos(b), PlayerInfo.getMostReliablePos(carrier));
                        return distA - distB;
                    });

                    if (goliaths.length > 0 && goliaths[0].id !== this.myId) {
                        // I am a goliath, but NOT the closest one. Head towards enemy base.
                        const gotoEnemyBase = new GotoLocationTarget(this.env, this.logger, this.defaultOtherFlagPos);
                        gotoEnemyBase.setInfo("head towards enemy base");
                        return gotoEnemyBase;
                    }
                }

                // Dynamic carrier protection based on health
                if (carrier && carrier.health < 0.5) {
                    const teammateBots = this.env.getPlayers().filter(p =>
                        p.team === this.myTeam &&
                        p.id !== carrier.id &&
                        p.name.endsWith("_") &&
                        PlayerInfo.isActive(p)
                    );

                    teammateBots.sort((a, b) => {
                        const carrierPos = PlayerInfo.getMostReliablePos(carrier);
                        const distA = this.getDistance(PlayerInfo.getMostReliablePos(a), carrierPos);
                        const distB = this.getDistance(PlayerInfo.getMostReliablePos(b), carrierPos);
                        return distA - distB;
                    });

                    const myIndex = teammateBots.findIndex(p => p.id === this.myId);
                    if (myIndex === 0) {
                        // Closest bot: Shield mode
                        const protectCarrier = new ProtectTarget(this.env, this.logger, this.character, carrier.id, 0, 150);
                        protectCarrier.setInfo("protect flag carrier (SHIELD)");
                        return protectCarrier;
                    } else if (myIndex === 1) {
                        // Second closest: Tight protection
                        const protectCarrier = new ProtectTarget(this.env, this.logger, this.character, carrier.id, 20, 300);
                        protectCarrier.setInfo("protect flag carrier (TIGHT)");
                        return protectCarrier;
                    }
                }

                const protectCarrier = new ProtectTarget(this.env, this.logger, this.character, Number(this.otherFlagInfo.carrierId), PROTECT_PLAYER_DISTANCE);
                protectCarrier.setInfo("protect flag carrier");
                return protectCarrier;
            }

            const grabFlag = new GotoLocationTarget(this.env, this.logger, this.otherFlagInfo.pos);
            grabFlag.setInfo("Go grab flag");
            return grabFlag;
        } else {
            const protectFlag = new ProtectTarget(this.env, this.logger, this.character, this.myFlagInfo.pos, PROTECT_FLAG_DISTANCE);
            protectFlag.setInfo("protect my flag");
            return protectFlag;
        }
    }


    private getDistance(pos1: Pos, pos2: Pos): number {
        const delta = Calculations.getDelta(pos1, pos2);
        if (delta) {
            return delta.distance;
        }
        return 1000000;
    }

    private updateFlagInfo() {
        const me = this.env.me();

        this.myId = me.id;

        if (this.myTeam !== me.team) {
            this.logger.info(`I am on the ${me.team === 1 ? "blue" : "red"} team`);
            this.myTeam = me.team;
            this.otherTeam = me.team === 1 ? 2 : 1;
        }

        this.myFlagInfo = this.env.getFlagInfo(this.myTeam);
        this.otherFlagInfo = this.env.getFlagInfo(this.otherTeam);

        this.defaultMyFlagPos = this.myTeam === 1 ? blueFlagPositions.defaultPos : redFlagPositions.defaultPos;
        this.defaultOtherFlagPos = this.myTeam === 1 ? redFlagPositions.defaultPos : blueFlagPositions.defaultPos;

        this.distanceToMyFlag = this.getDistance(this.myFlagInfo.pos, me.pos);
        this.distanceToOtherFlag = this.getDistance(this.otherFlagInfo.pos, me.pos);

        if (!this.myRole || this.isAutoMode) {
            this.selectRole();
        }
    }

    public selectRole() {
        let desiredRole = this.slave.getDefaultRole();

        if (this.isAutoMode && this.myFlagInfo && this.otherFlagInfo) {
            const ctfScores = this.env.getCtfScores();
            if (ctfScores && (ctfScores[1] !== undefined || ctfScores[2] !== undefined)) {
                const myScore = ctfScores[this.myTeam] || 0;
                const otherScore = ctfScores[this.otherTeam] || 0;
                const myFlagIsOut = !!this.myFlagInfo.carrierId;

                if (otherScore === 2 && myScore === 0) {
                    desiredRole = 'D';
                } else if (otherScore - myScore >= 1 && myFlagIsOut) {
                    desiredRole = 'D';
                } else if (myScore >= 2) {
                    desiredRole = 'A';
                } else if (myScore === 1 && !myFlagIsOut) {
                    desiredRole = 'A';
                }
            }
        }

        if (this.myRole !== desiredRole) {
            this.myRole = desiredRole;
            this.logger.info("My role is " + this.myRole);
        }
    }

    private determineFlagState(): FlagStates {

        if (!this.myFlagInfo.pos || !this.otherFlagInfo.pos) {
            // no need to evaluate further
            return FlagStates.Unknown;
        }

        if (this.otherFlagInfo.carrierId === this.myId) {
            const myPos = this.env.me().pos;
            if (this.myTeam === 1) {
                if (myPos.y < redFlagPositions.safeLines.y && myPos.x > redFlagPositions.safeLines.x) {
                    return FlagStates.ImCarrierInDangerZone;
                }
            }
            if (this.myTeam === 2) {
                if (myPos.y < blueFlagPositions.safeLines.y && myPos.x < blueFlagPositions.safeLines.x) {
                    return FlagStates.ImCarrierInDangerZone;
                }
            }

            return FlagStates.ImCarrier;
        }

        const currentFlagStates: { state: FlagStates; distanceToEvent: number }[] = [];

        // my flag taken?
        if (this.myFlagInfo.carrierId) {
            const carrier = this.env.getPlayer(this.myFlagInfo.carrierId);
            if (carrier) {
                const deltaToCarrier = Calculations.getDelta(PlayerInfo.getMostReliablePos(carrier), this.env.me().pos);
                if (deltaToCarrier) {
                    currentFlagStates.push({
                        state: FlagStates.MyFlagTaken,
                        distanceToEvent: deltaToCarrier.distance
                    });
                }
            }
            // my flag displaced?
        } else if (this.getDistance(this.defaultMyFlagPos, this.myFlagInfo.pos) > 100) {
            const deltaToFlag = Calculations.getDelta(this.myFlagInfo.pos, this.env.me().pos);
            if (deltaToFlag) {
                currentFlagStates.push({
                    state: FlagStates.MyFlagDisplaced,
                    distanceToEvent: deltaToFlag.distance
                });
            }
        }

        // other flag taken?
        if (this.otherFlagInfo.carrierId) {
            const carrier = this.env.getPlayer(this.otherFlagInfo.carrierId);
            if (carrier) {
                const deltaToCarrier = Calculations.getDelta(PlayerInfo.getMostReliablePos(carrier), this.env.me().pos);
                if (deltaToCarrier) {
                    currentFlagStates.push({
                        state: FlagStates.OtherFlagTaken,
                        distanceToEvent: deltaToCarrier.distance
                    });
                }
            }
        }

        if (currentFlagStates.length === 0) {
            return FlagStates.AllIsPeaceful;
        }

        currentFlagStates.sort((a, b) => a.distanceToEvent - b.distanceToEvent);
        return currentFlagStates[0].state;
    }


    private onPlayerKilled(data: any) {
        for (const t of this.targets) {
            t.onKill(data.killerID, data.killedID);
        }
    }

    private clearAllTargets() {
        this.targets = [];
    }

    execCtfCommand(playerID: number, command: string, param: string) {

        const player = this.env.getPlayer(playerID);
        const me = this.env.me();

        if (!player || !me || player.team !== me.team) {
            return;
        }

        switch (command) {
            case 'drop':
                const currentTarget = this.peek();
                if (currentTarget && currentTarget.goal === 'handoverflag') {
                    return;
                }
                if (FlagHelpers.isCarryingFlag(this.env)) {
                    const distance = this.getDistance(me.pos, PlayerInfo.getMostReliablePos(player));
                    if (distance > TOO_FAR_AWAY_FOR_POOPING_FLAG) {
                        this.env.sendTeam("Too far away!", false);
                    } else {
                        const target = new HandOverFlagTarget(this.env, this.logger, playerID);
                        target.isSticky = true;
                        this.targets.push(target);
                        this.env.sendTeam("I'll try bringing you the flag during 10 seconds.", false);
                    }
                }
                break;

            case 'assist':
                const playerToAssist = this.env.getPlayer(Number(param));

                this.clearAllTargets();
                if (playerToAssist && playerToAssist.team === this.myTeam && playerToAssist.id !== me.id) {
                    const target = new ProtectTarget(this.env, this.logger, this.character, playerToAssist.id, PROTECT_PLAYER_DISTANCE);
                    target.isSticky = true;
                    this.targets.push(target);
                }
                this.isAutoMode = false;
                break;

            case 'meet':
                const playerToMeet = this.env.getPlayer(Number(param));
                if (playerToMeet && playerToMeet.team === this.myTeam && playerToMeet.id !== me.id) {
                    const target = new MeetTarget(this.env, this.logger, playerToMeet.id);
                    target.isSticky = true;
                    this.targets.push(target);
                }
                break;

            case 'defend':
                this.isAutoMode = false;
                break;

            case 'capture':
                this.isAutoMode = false;
                break;

            case 'auto':
                this.isAutoMode = true;
                break;
        }
    }

    public setRole(role: "A" | "D") {
        this.myRole = role;
    }
}
