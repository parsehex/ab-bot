import { Calculations } from "../calculations";
import { PlayerInfo } from "../airmash/player-info";
import { PathFindingFacade } from "./pathfinding-facade";
import { Pos } from "../pos";

let mountains;

class ScaledPos extends Pos {
    scale: number;

    static fromPos(pos: Pos): ScaledPos {
        return { ...pos, scale: null};
    }
}

export class PathFinding {

    private readonly mobstacles: any[];
    private readonly playerObstacles: any[];

    private readonly navConfig = {
        // map is -16352 to 16352 in the x direction and -8160 to 8160 in the y-direction
        mapProperties: { left: -16500, top: -8300, right: 16500, bottom: 8300 },
        maxGridLength: 3000,
        marginStep: 1000,
        scale: 0.1
    };
    
    constructor(walls: number[][], missiles: any[], playersToAvoid: PlayerInfo[]) {

        if (!mountains) {
            mountains = walls.map(w => {
                return {
                    x: w[0],
                    y: w[1],
                    size: w[2],
                };
            });
        }

        this.mobstacles = missiles.map(m => {
            const pos = Calculations.predictPosition(50, m.pos, m.speed);
            return {
                x: pos.x,
                y: pos.y,
                size: 50    
            };
        });

        this.playerObstacles = playersToAvoid.map(p => {
            const pos = Calculations.predictPosition(50, p.pos, p.speed);
            return {
                x: pos.x,
                y: pos.y,
                size: 50
            };
        });
    }

    private getGrid(width: number, height: number, left: number, top: number): any {

        const grid = new PathFindingFacade.Grid(Math.ceil(width), Math.ceil(height));

        const removeWalkabilityfor = obstacle => {
            const scaledObstacle = {
                x: obstacle.x * this.navConfig.scale,
                y: obstacle.y * this.navConfig.scale,
                size: obstacle.size * this.navConfig.scale
            };

            if (scaledObstacle.x < left - scaledObstacle.size || scaledObstacle.x > left + width + scaledObstacle.size) {
                return;
            }
            if (scaledObstacle.y < top - scaledObstacle.size || scaledObstacle.y > top + height + scaledObstacle.size) {
                return;
            }

            // remove walkability of this mountain
            const obsLeft = scaledObstacle.x - scaledObstacle.size;
            const obsRight = scaledObstacle.x + scaledObstacle.size;
            const obsTop = scaledObstacle.y - scaledObstacle.size;
            const obsBottom = scaledObstacle.y + scaledObstacle.size;
            for (let i = obsLeft; i <= obsRight; i++) {
                for (let j = obsTop; j <= obsBottom; j++) {
                    const gridX = Math.floor(i - left);
                    const gridY = Math.floor(j - top);
                    if (gridX < 0 || gridX >= width || gridY < 0 || gridY >= height) {
                        continue;
                    }
                    grid.setWalkableAt(gridX, gridY, false);
                }
            }
        };

        mountains.forEach(x => removeWalkabilityfor(x));
        this.mobstacles.forEach(x => removeWalkabilityfor(x));
        this.playerObstacles.forEach(x => removeWalkabilityfor(x));

        return grid;
    }

    private isValid(pos: { x: number, y: number }): boolean {
        const margin = 32 * this.navConfig.scale;
        return pos.x > this.navConfig.mapProperties.left * this.navConfig.scale + margin &&
            pos.x < this.navConfig.mapProperties.right * this.navConfig.scale - margin &&
            pos.y > this.navConfig.mapProperties.top * this.navConfig.scale + margin &&
            pos.y < this.navConfig.mapProperties.bottom * this.navConfig.scale - margin;
    }

    private scale(pos: ScaledPos): ScaledPos {
        if (pos.scale) {
            // has already been scaled
            return pos;
        }
        return {
            x: pos.x * this.navConfig.scale,
            y: pos.y * this.navConfig.scale,
            scale: this.navConfig.scale,
            isAccurate: pos.isAccurate
        };
    }

    public findPath(myPos: Pos, otherPos: Pos): Pos[] {
        try {
            return this.findPathInner(ScaledPos.fromPos(myPos), ScaledPos.fromPos(otherPos), 0);
        } catch (error) {
            // better luck next time 
            return [];
        }
    }

    public findPathInner(myPos: ScaledPos, otherPos: ScaledPos, margin: number, level: number = 1): Pos[] {
        myPos = this.scale(myPos);
        otherPos = this.scale(otherPos);

        if (!this.isValid(myPos)) {
            return [];
        }

        if (!this.isValid(otherPos)) {
            let posLog = "";
            if (otherPos) {
                posLog = otherPos.x + "," + otherPos.y;
            }
            return [];
        }

        const halvarin = margin / 2;

        let gridLeft: number;
        const gridWidth = Math.min(this.navConfig.maxGridLength, Math.abs(otherPos.x - myPos.x) + margin);
        if (otherPos.x > myPos.x) {
            gridLeft = myPos.x - halvarin;
        } else {
            gridLeft = myPos.x - gridWidth + 1 + halvarin;
        }

        if (gridLeft < this.navConfig.mapProperties.left * this.navConfig.scale) {
            gridLeft = this.navConfig.mapProperties.left * this.navConfig.scale;
        }
        if (gridLeft + gridWidth > this.navConfig.mapProperties.right * this.navConfig.scale) {
            gridLeft = this.navConfig.mapProperties.right * this.navConfig.scale - gridWidth - 1;
        }

        let gridTop: number;
        const gridHeight = Math.min(this.navConfig.maxGridLength, Math.abs(otherPos.y - myPos.y) + margin);
        if (otherPos.y > myPos.y) {
            gridTop = myPos.y - halvarin;
        } else {
            gridTop = myPos.y - gridHeight + 1 + halvarin;
        }

        if (gridTop < this.navConfig.mapProperties.top * this.navConfig.scale) {
            gridTop = this.navConfig.mapProperties.top * this.navConfig.scale;
        }
        if (gridTop + gridHeight > this.navConfig.mapProperties.bottom * this.navConfig.scale) {
            gridTop = this.navConfig.mapProperties.bottom * this.navConfig.scale - gridHeight - 1;
        }

        // get grid with mountains
        const grid = this.getGrid(gridWidth, gridHeight, gridLeft, gridTop);

        const finder = new PathFindingFacade.AStarFinder({
            allowDiagonal: true
        });

        const fromX = Math.floor(myPos.x - gridLeft);
        let fromY = Math.floor(myPos.y - gridTop);
        let toX = otherPos.x - gridLeft;
        let toY = otherPos.y - gridTop;

        // target may not be "visible" in our grid
        if (toX < 0) {
            toX = 0;
        }
        if (toX >= gridWidth) {
            toX = gridWidth - 1;
        }

        let searchDirection = 1;
        if (toY < 0) {
            toY = 0;
        }
        if (toY >= gridHeight) {
            toY = gridHeight - 1;
            searchDirection = -1;
        }

        toX = Math.floor(toX);
        toY = Math.floor(toY);

        // prevent to round to an unwalkable place: go up or down until a walkable place was found
        while (!grid.isWalkableAt(toX, toY) && toY > 0 && toY < gridHeight - 1) {
            toY += searchDirection;
        }
        while (!grid.isWalkableAt(fromX, fromY) && fromY > 0 && fromY < gridHeight - 1) {
            fromY += searchDirection;
        }

        let path = finder.findPath(fromX, fromY, toX, toY, grid);

        if (path.length > 0) {
            path = PathFindingFacade.Util.smoothenPath(grid, path);

            const result = [];
            for (let i = 0; i < path.length; i++) {
                const x = (path[i][0] + gridLeft) / this.navConfig.scale;
                const y = (path[i][1] + gridTop) / this.navConfig.scale;
                result.push({ x, y });
            }
            return result;
        } else {
            // this is an unwalkable path. Try broadening the grid to find a way around an obstacle (mountain)
            if (level > 8 || margin >= this.navConfig.maxGridLength * this.navConfig.scale) {
                return []; // sorry, can't find a path
            }
            return this.findPathInner(myPos, otherPos, margin + (this.navConfig.marginStep * this.navConfig.scale), level + 1);
        }
    }


}