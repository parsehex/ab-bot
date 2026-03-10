import { Calculations } from "../bot/calculations";

export class AircraftTypeAllocator {
    private lastAircraftType = 0;
    private goliCount = 0;
    private maxGolis = 2; // Default to 2

    constructor(websocketUrl?: string) {
        if (websocketUrl && websocketUrl.includes('ctf')) {
            this.maxGolis = 4; // Allow more in CTF as there are two teams
        }
    }

    getNextType(typeConfig: string): string {
        if (!typeConfig || typeConfig === 'random') {
            return Calculations.getRandomInt(1, 6).toString();
        }

        if (typeConfig === 'distribute' || typeConfig === 'd') {
            do {
                this.lastAircraftType++;
                if (this.lastAircraftType > 5) {
                    this.lastAircraftType = 1;
                }
            } while (this.lastAircraftType === 2 && this.goliCount >= this.maxGolis);

            if (this.lastAircraftType === 2) {
                this.goliCount++;
            }
            return this.lastAircraftType.toString();
        }

        return typeConfig;
    }
}
