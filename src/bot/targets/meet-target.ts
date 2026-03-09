import { ITarget } from "./itarget";
import { GotoLocationInstruction } from "../instructions/goto-location";
import { IInstruction } from "../instructions/iinstruction";
import { GotoLocationConfig } from "../instructions/goto-location-config";
import { IAirmashEnvironment } from "../airmash/iairmash-environment";
import { Pos } from "../pos";
import { BaseTarget } from "./base-target";
import { Logger } from "../../helper/logger";
import { PlayerInfo } from "../airmash/player-info";
import { Calculations } from "../calculations";

const GATHER_RADIUS = 300;
const DISMISS_RADIUS = 800;

export class MeetTarget extends BaseTarget {
    private gotoLocationConfig: GotoLocationConfig;

    goal = "meet";
    private manualInfo: string;
    private hasGathered = false;
    
    constructor(private env: IAirmashEnvironment, private logger: Logger, private readonly targetId: number) {
        super();
        this.gotoLocationConfig = new GotoLocationConfig(env.myId());
        this.isSticky = true;
    }

    onKill(killerID: number, killedID: number) {
    }

    getInstructions(): IInstruction[] {
        const result = [];

        const targetPlayer = this.env.getPlayer(this.targetId);
        let targetPos = new Pos({x: 0, y: 0});
        if (targetPlayer && targetPlayer.pos) {
            targetPos = PlayerInfo.getMostReliablePos(targetPlayer);
        }

        this.gotoLocationConfig.desiredDistanceToTarget = 0;
        this.gotoLocationConfig.targetPos = targetPos;

        const instruction = new GotoLocationInstruction(this.env, this.logger, null);
        instruction.configure(this.gotoLocationConfig);
        result.push(instruction);

        return result;
    }

    getInfo() {
        const targetPlayer = this.env.getPlayer(this.targetId);
        let pName = 'unknown';
        let pPos = null;
        if (targetPlayer) {
            pName = targetPlayer.name;
            pPos = PlayerInfo.getMostReliablePos(targetPlayer);
        }

        return {
            info: this.manualInfo || 'meeting ' + pName,
            id: this.targetId,
            pos: pPos
        };
    }

    setInfo(info: string) {
        this.manualInfo = info;
    }

    isValid(): boolean {
        const targetPlayer = this.env.getPlayer(this.targetId);
        if (!targetPlayer) {
            return false; // Player lost
        }

        const me = this.env.me();
        if (!me) {
            return false;
        }

        const targetPos = PlayerInfo.getMostReliablePos(targetPlayer);
        const myPos = me.pos;

        // Note: isBot logic assumes player name ending in '_' is a bot
        // This is safe for the default spatiebot names
        const allMyTeamBots = this.env.getPlayers().filter(p => 
            p.team === me.team && 
            PlayerInfo.isActive(p) && 
            p.name.endsWith('_')
        );

        if (allMyTeamBots.length > 0) {
            let gatheredCount = 0;
            for (const bot of allMyTeamBots) {
                const botPos = PlayerInfo.getMostReliablePos(bot);
                const dist = Calculations.getDelta(targetPos, botPos).distance;
                if (dist < GATHER_RADIUS) {
                    gatheredCount++;
                }
            }

            if (gatheredCount / allMyTeamBots.length >= 0.8) {
                this.hasGathered = true;
            }
        }

        if (this.hasGathered) {
            const distFromTargetToMe = Calculations.getDelta(targetPos, myPos).distance;
            if (distFromTargetToMe > DISMISS_RADIUS) {
                return false; // Dismissed
            }
        }

        return true;
    }
}
