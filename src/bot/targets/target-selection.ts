import { ITarget } from "./itarget";
import { IAirmashEnvironment } from "../airmash/iairmash-environment";
import { DodgeMissileTarget } from "./dodge-missile-target";
import { BotCharacter } from "../bot-character";
import { CrateTarget } from "./crate-target";
import { OtherPlayerTarget } from "./other-player-target";
import { DoNothingTarget } from "./do-nothing.target";
import { DodgeEnemiesTarget } from "./dodge-enemies-target";
import { GotoLocationTarget } from "./goto-location-target";
import { Pos } from "../pos";
import { Calculations } from "../calculations";
import { ProtectTarget } from "./protect-target";

const TIME_OUT = 60 * 1000; // 1 min
const PROTECT_TIME_OUT = 5 * TIME_OUT;

export class TargetSelection {
    private target: ITarget;
    private ctfTarget: ITarget;
    private lastLoggedTarget: string;
    private lastSelectedTime: number = 0;
    private lastTargetId: number;
    private dontSelectId: number;
    private timeout: number = 0;
    private protectId: number = 0;
    private ctfType: number = 0; // attacking (1) or defending bot (2)

    constructor(private env: IAirmashEnvironment, private character: BotCharacter) {
        this.env.on('playerkilled', (x) => this.onPlayerKilled(x));
        this.env.on('chat', msg => this.onChat(msg));
    }

    reset() {
        this.target = null;
        this.lastSelectedTime = 0;
        this.lastLoggedTarget = "";
        this.ctfType = 0;

        // this was called on error, prevent selection of the same id the next time
        this.dontSelectId = this.lastTargetId;
        this.lastTargetId = null;
        this.protectId = null;
        this.timeout = Date.now() + 1000; // wait a sec before next target
    }

    private onPlayerKilled(data: any) {
        if (this.target) {
            this.target.onKill(data.killerID, data.killedID);
        }
    }

    private onChat(msg) {
        if (msg.id === this.env.myId()) {
            return;
        }
        if (this.character.goal === 'protect') {
            if (msg.text.indexOf('#protect me') !== -1) {
                console.log('Protect me instruction received');
                if (!this.protectId) {
                    this.protectId = msg.id;
                    console.log('ProtectID: ' + this.protectId);
                    const player = this.env.getPlayer(this.protectId);
                    if (player) {
                        this.env.sendChat("OK, " + player.name + ", I'm coming!")
                    } else {
                        console.log('ProtectID apparently invalid');
                        this.protectId = null;
                    }
                } else {
                    console.log("ignoring: already on another target");
                }
            } else if (msg.text.indexOf('#unprotect') !== -1) {
                console.log('Unprotect message');
                if (this.protectId === msg.id) {
                    console.log('From protectplayer');
                    const player = this.env.getPlayer(this.protectId);
                    this.env.sendChat("Roger that, " + player.name);
                    this.protectId = null;
                    this.target = null;
                }
            }
        }
    }

    getTarget(): ITarget {
        if (Date.now() < this.timeout) {
            return new DoNothingTarget();
        }

        let target = this.getPriorityTarget();
        if (!target) {
            if (this.env.getGameType() === 2) {
                target = this.getCtfTarget();
                this.ctfTarget = target;
            }
        }

        if (!target) {
            this.selectRegularTarget();
            target = this.target;
        }

        const targetInfo = target.getInfo();
        if (this.lastLoggedTarget !== targetInfo.info) {
            this.lastLoggedTarget = targetInfo.info
            console.log("Target: " + targetInfo.info);
        }

        if (targetInfo.id) {
            this.lastTargetId = targetInfo.id;
        }

        return target;
    }

    private getCtfTarget(): ITarget {

        const me = this.env.me();
        const myFlagInfo = this.env.getFlagInfo(me.team);
        const otherFlagInfo = this.env.getFlagInfo(me.team === 1 ? 2 : 1);

        if (!myFlagInfo.pos) {
            return;
        }
        if (!otherFlagInfo.pos) {
            return;
        }

        if (this.ctfType === 0) {
            this.ctfType = Calculations.getRandomInt(1, 3);
            console.log("I am " + (this.ctfType === 1 ? "an attacker" : "on D"));
        }

        const flagDefaultX = me.team === 1 ? -9670 : 8600;
        const flagDefaultY = me.team === 1 ? -1470 : -940;

        if (otherFlagInfo.carrierId === me.id) {
            // i'm the flag carrier! Bring it home.
            return new GotoLocationTarget(this.env, new Pos({ x: flagDefaultX, y: flagDefaultY }));
        }

        let potentialNewTargets: ITarget[] = [];
        if (myFlagInfo.carrierId && myFlagInfo.carrierId !== this.dontSelectId) {
            // flag is taken, hunt the carrier
            if (this.ctfTarget && this.ctfTarget.getInfo().id === myFlagInfo.carrierId && this.ctfTarget.isValid()) {
                // already hunting
                return this.ctfTarget;
            }

            const killFlagCarrier = new OtherPlayerTarget(this.env, this.character, [], myFlagInfo.carrierId);

            if (killFlagCarrier.isValid()) {
                potentialNewTargets.push(killFlagCarrier);
            }
        }

        const flagIsHome = myFlagInfo.pos.x === flagDefaultX && myFlagInfo.pos.y === flagDefaultY;
        if (!flagIsHome) {
            // flag should be recovered
            const recoverFlag = new GotoLocationTarget(this.env, myFlagInfo.pos);
            potentialNewTargets.push(recoverFlag);
        }
        const isDefensive = this.ctfType === 2;

        if (isDefensive) {
            const protectFlag = new ProtectTarget(this.env, this.character, myFlagInfo.pos);
            potentialNewTargets.push(protectFlag);
        } else {
            if (!otherFlagInfo.carrierId) {
                // protect the carrier
                const protectCarrier = new ProtectTarget(this.env, this.character, otherFlagInfo.carrierId);
                potentialNewTargets.push(protectCarrier);
            } else {
                // go grab the enemy flag
                const grabFlag = new GotoLocationTarget(this.env, otherFlagInfo.pos);
                potentialNewTargets.push(grabFlag);
            }
        }

        try {
            potentialNewTargets.sort((a, b) => {
                const distanceA = Calculations.getDelta(me.pos, a.getInfo().pos).distance;
                const distanceB = Calculations.getDelta(me.pos, b.getInfo().pos).distance;
                return distanceA - distanceB;
            });
        } catch (error) {
            // whatever
        }

        return potentialNewTargets[0];
    }

    private getPriorityTarget(): ITarget {
        // dodging bullets is always a priority
        const dodge = new DodgeMissileTarget(this.env, this.character, [this.dontSelectId]);
        if (dodge.isValid()) {
            return dodge;
        }

        const dontSelect = [this.dontSelectId];
        if (this.protectId) {
            dontSelect.push(this.protectId);
        }
        const avoid = new DodgeEnemiesTarget(this.env, this.character, dontSelect);
        if (avoid.isValid()) {
            return avoid;
        }

        return null;
    }

    private selectRegularTarget(): void {

        const hasTarget = !!this.target;
        const isFulfillingPrimaryGoal = hasTarget && this.target.goal === this.character.goal;
        const timeOut = hasTarget && this.target.goal === 'protect' ? PROTECT_TIME_OUT : TIME_OUT;
        const isTargetTimedOut = Date.now() - this.lastSelectedTime > timeOut;
        const isTargetValid = hasTarget && !isTargetTimedOut && this.target.isValid();
        const isLastResortTarget = isTargetValid && this.target.goal === "nothing" && this.character.goal !== "nothing";

        if (isTargetValid && isFulfillingPrimaryGoal) {
            // no need to select another target
            return;
        }

        if (isTargetTimedOut) {
            console.log("Target timed out. Select a new one");

            this.protectId = null;
        }

        let potentialNewTarget: ITarget;
        if (this.character.goal === 'stealCrates') {
            potentialNewTarget = new CrateTarget(this.env, [this.dontSelectId]);
        } else if (this.character.goal === 'fight') {
            potentialNewTarget = new OtherPlayerTarget(this.env, this.character, [this.dontSelectId]);
        } else if (this.character.goal === "nothing") {
            potentialNewTarget = new DoNothingTarget();
        } else if (this.character.goal === "protect") {
            potentialNewTarget = new ProtectTarget(this.env, this.character, this.protectId);
        }

        if (potentialNewTarget && potentialNewTarget.isValid()) {
            this.target = potentialNewTarget;
            this.lastSelectedTime = Date.now();
            return;
        }

        // now we have a failed attempt at selecting a new target, while it's still necessary to select one.
        // maybe on second thought it's not that important. At least we need a valid target, even if it
        // does not fulfill the primary goal
        if (isTargetValid && !isLastResortTarget) {
            return;
        }

        // so take the default target then
        this.target = new OtherPlayerTarget(this.env, this.character, [this.dontSelectId]);
        this.lastSelectedTime = Date.now();

        if (!this.target.isValid()) {
            // even the default target failed. We're out of ideas.
            this.target = new DoNothingTarget();
            this.lastSelectedTime = Date.now();
        }
    }
}