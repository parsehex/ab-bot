import { Pos } from "../pos";
import { StopWatch } from "../../helper/timer";
import { Calculations } from "../calculations";

const ABSOLUTE_THROTTLE_MS = 50;
const PATH_FINDING_LOWER_LIMIT_MS = 250;
const PATH_FINDING_UPPER_LIMIT_MS = 800;
const MAX_SPEED_PER_MS = 1;

const caches = {};

const absoluteThrottleTimer = new StopWatch();
absoluteThrottleTimer.start();

const PATHFINDING_FAILURE_BACKOFF_MS = 500; // Backoff delay when pathfinding fails repeatedly
const MAX_PATHFINDING_ERRORS_BEFORE_BACKOFF = 5; // After this many errors, apply backoff

export class GotoLocationConfig {
    private readonly id: number;

    constructor(botId: number) {
        this.id = botId;
        caches[this.id] = caches[this.id] || {
            sw: new StopWatch(),
            lastPath: [],
            throttleMs: 0,
            lastPathfindingFailureTime: 0,
            consecutivePathfindingErrors: 0,
        };
    }

    private get myThrottleTimer(): StopWatch {
        return caches[this.id].sw;
    }

    private get myThrottleMs(): number {
        return caches[this.id].throttleMs;
    }
    private set myThrottleMs(value: number) {
        caches[this.id].throttleMs = value;
    }

    get lastPath(): Pos[] {
        return caches[this.id].lastPath;
    }
    set lastPath(value: Pos[]) {
        caches[this.id].lastPath = value;
    }

    setLastPath(path: Pos[]) {
        this.myThrottleTimer.start();
        absoluteThrottleTimer.start();
        this.lastPath = path;
        caches[this.id].consecutivePathfindingErrors = 0; // Reset error count on successful path

        if (path && path.length > 1) {
            const myPos = path[0];
            const firstPos = path[1];

            const diff = Calculations.getDelta(myPos, firstPos);
            if (diff) {
                this.myThrottleMs = diff.distance / MAX_SPEED_PER_MS;
            }
        }
    }

    recordPathfindingError(): void {
        caches[this.id].consecutivePathfindingErrors++;
        caches[this.id].lastPathfindingFailureTime = Date.now();
    }

    isPathfindingInBackoff(): boolean {
        const consecutiveErrors = caches[this.id].consecutivePathfindingErrors;
        if (consecutiveErrors < MAX_PATHFINDING_ERRORS_BEFORE_BACKOFF) {
            return false;
        }
        const timeSinceFailure = Date.now() - caches[this.id].lastPathfindingFailureTime;
        return timeSinceFailure < PATHFINDING_FAILURE_BACKOFF_MS;
    }

    shouldCalculatePath(): boolean {
        if (absoluteThrottleTimer.elapsedMs() < ABSOLUTE_THROTTLE_MS) {
            return false;
        }

        // Don't try pathfinding if we're in backoff due to repeated failures
        if (this.isPathfindingInBackoff()) {
            return false;
        }

        if (!this.lastPath || this.lastPath.length < 2) {
            return true;
        }
        const timeoutMs = Math.min(Math.max(this.myThrottleMs, PATH_FINDING_LOWER_LIMIT_MS), PATH_FINDING_UPPER_LIMIT_MS);
        return this.myThrottleTimer.elapsedMs() > timeoutMs;
    }

    targetPos: Pos;
    desiredDistanceToTarget: number;
    shouldFleeFrom: boolean;
    errors = 0;
    flyBackwards: boolean;
}
