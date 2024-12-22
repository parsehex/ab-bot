import { ITargetSelection } from "./itarget-selection";
import { CtfTargetSelection } from "./ctf-target-selection";
import { Slave } from "../../teamcoordination/slave";
import { BotContext } from "../../botContext";
import { FfaTargetSelection } from "./ffa-target-selection";
import { InfTargetSelection } from './inf-target-selection';

export class TargetSelectionFactory {
    static createTargetSelection(context: BotContext, slave: Slave): ITargetSelection {
        if (context.env.getGameType() === 2) {
            const ts = new CtfTargetSelection(context, slave);
            slave.setCtfTargetSelection(ts);
            return ts;
        }

        if (context.env.getGameType() === 4) {
            const ts = new InfTargetSelection(context, slave);
            slave.setInfTargetSelection(ts);
            return ts;
        }

        return new FfaTargetSelection(context);
    }
}
