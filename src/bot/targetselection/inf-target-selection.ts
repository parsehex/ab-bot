import { ITargetSelection } from "./itarget-selection";
import { IAirmashEnvironment } from "../airmash/iairmash-environment";
import { BotCharacter } from "../bot-character";
import { ITarget } from "../targets/itarget";
import { Calculations } from "../calculations";
import { Pos } from "../pos";
import { DoNothingTarget } from "../targets/do-nothing.target";
import { DodgeMissileTarget } from "../targets/dodge-missile-target";
import { GotoLocationTarget } from "../targets/goto-location-target";
import { OtherPlayerTarget } from "../targets/other-player-target";
import { ProtectTarget } from "../targets/protect-target";
import { StopWatch } from "../../helper/timer";
import { Logger } from "../../helper/logger";
import { Slave } from "../../teamcoordination/slave";
import { BotContext } from '../../botContext';

enum FlagStates {
    Unknown = "Unkown",
    Infected = "I'm infected",
    Healing = "Healing"
}

const blueBasePositions = {
    defaultPos: new Pos({ x: -9670, y: -1470 }),
};

const redSpawnPositions = {
    defaultPos: new Pos({ x: 8600, y: -940 }),
};

const REEVALUATION_TIME_MS = 1500;
const FIGHT_DISTANCE_THRESHOLD = 300;

export class InfTargetSelection implements ITargetSelection {

    // cached state
    private myId: number;
    private infectedPlayerInfo: any; // TODO: define type
    private myTeam: number;
    private otherTeam: number;
    private flagState: FlagStates;
    private defaultMyBasePos: Pos;

    // real state
    private myRole: string;
    private targets: ITarget[] = [];
    private lastLog: string;
    private stopwatch = new StopWatch();
    private distanceToInfectedPlayer: number;

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
    }

    reset(): void {
        this.clearAllTargets();
        this.lastLog = null;
        this.stopwatch.start();

        this.slave.repeatLastCommand();
    }

    dispose(): void {
        // no subscriptions to remove
    }

    exec(): ITarget {

        this.updateInfectedPlayerInfo();
        const flagstate = this.determineFlagState();

        if (flagstate !== this.flagState) {
            this.logger.info("Most urgent flagstate: " + flagstate);
            this.flagState = flagstate;
        }

        this.updateTargetStack();

        this.logState();

        this.targets.forEach(element => {
            element.isActive = false;
        });

        const activeTarget = this.peek();
        activeTarget.isActive = true;
        return activeTarget;
    }

    private peek(): ITarget {
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

        if (this.flagState !== FlagStates.Infected) {
            // attack infected players nearby
            const fight = new OtherPlayerTarget(this.env, this.logger, this.character, []);
            fight.setMaxDistance(FIGHT_DISTANCE_THRESHOLD);
            if (fight.isValid()) {
                this.targets.push(fight);
                return;
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
            this.logger.info("Inf target: " + info.info);
            this.lastLog = info.info;
        }
    }

    private determineTarget(): ITarget {

        if (this.flagState === FlagStates.Unknown) {
            return new DoNothingTarget();
        }

        const doDefensiveActions = true; // always defend in Inf mode

        if (this.flagState === FlagStates.Infected) {
            const goHeal = new GotoLocationTarget(this.env, this.logger, blueBasePositions.defaultPos);
            goHeal.setInfo("Go heal");
            return goHeal;
        }

        if (doDefensiveActions) {
            // attack infected players nearby
            const fight = new OtherPlayerTarget(this.env, this.logger, this.character, []);
            fight.setMaxDistance(FIGHT_DISTANCE_THRESHOLD);
            return fight;
        }
    }

    private updateInfectedPlayerInfo() {
        const me = this.env.me();

        this.myId = me.id;

        if (this.myTeam !== me.team) {
            this.logger.info(`I am on the ${me.team === 1 ? "blue" : "red"} team`);
            this.myTeam = me.team;
            this.otherTeam = me.team === 1 ? 2 : 1;
        }

        const infectedPlayerInfo = this.env.getPlayer(this.myId);
        if (infectedPlayerInfo) {
            this.infectedPlayerInfo = infectedPlayerInfo;
            this.distanceToInfectedPlayer = Calculations.getDelta(infectedPlayerInfo.pos, me.pos).distance;
        } else {
            this.infectedPlayerInfo = null;
            this.distanceToInfectedPlayer = Infinity;
        }

        if (!this.myRole) {
            this.selectRole();
        }
    }

    public selectRole() {
        this.myRole = "D";
        this.logger.info("My role is " + this.myRole);
    }

    private determineFlagState(): FlagStates {

        if (this.infectedPlayerInfo && this.distanceToInfectedPlayer < 1000) {
            return FlagStates.Infected;
        } else {
            return FlagStates.Unknown;
        }
    }

    private clearAllTargets() {
        this.targets = [];
    }
}
