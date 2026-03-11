/// <reference types="node" />
import { Pos } from "../pos";
import easystarjs from "easystarjs";
import { Missile } from "../airmash/missile";
import { simplifyPath } from "./simplifyPath";
import * as fs from 'fs';
import * as workerpool from 'workerpool';

const gridContainer = gridContainerFromMountainData("data/mountains.json");

function gridContainerFromMountainData(path: string) {

    let width;
    let height;
    const grids = {};

    initialize();

    const scaleDownX = width / 33000; // scale relative to airmash map
    const scaleDownY = height / 16600; 
    const scaleUpX = 33000 / width; 
    const scaleUpY = 16600 / height;
    const transX = width / 2; // translation: airmash has it's center at 0,0
    const transY = height / 2;

    return {
        width,
        height,
        grids,
        scaleUpX,
        scaleUpY,
        posToGridPos,
        posToAirmashPos,
    };

    function initialize() {
        const json = fs.readFileSync(path, "utf-8");

        const mountains = JSON.parse(json);
        width = mountains.grid.width;
        height = mountains.grid.height;


        for (let type = 1; type <= 5; type++) {
            grids[type] = createGrid(type, mountains);
        }
    }

    function posToGridPos(pos: Pos): Pos {
        let x = Math.round(pos.x * scaleDownX + transX);
        let y = Math.round(pos.y * scaleDownY + transY);

        // Clamp to grid boundaries
        x = Math.max(0, Math.min(width - 1, x));
        y = Math.max(0, Math.min(height - 1, y));

        return new Pos({ x, y });
    }

    function posToAirmashPos(pos: { x: number; y: number }): Pos {
        let x = (pos.x - transX) * scaleUpX;
        let y = (pos.y - transY) * scaleUpY;

        // Clamp to server boundaries
        x = Math.max(-16384, Math.min(16383, x));
        y = Math.max(-8192, Math.min(8191, y));

        return new Pos({ x, y });
    }

    function createGrid(type: number, mountains: any): number[][] {

        const width = mountains.grid.width;
        const height = mountains.grid.height;

        const grid: number[][] = [];
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                if (!grid[y]) {
                    grid[y] = [];
                }

                grid[y][x] = 0;
            }
        }

        for (const m of mountains[type]) {
            grid[m.y][m.x] = Math.round(m.v / 10);
        }

        return grid;
    }
}

async function doPathFinding(workerData): Promise<Pos[]> {

    const missiles: Missile[] = workerData.missiles;
    const myPos: Pos = workerData.myPos;
    const myType: number = workerData.myType;
    const targetPos: Pos = workerData.targetPos;

    let grid: number[][];

    grid = gridContainer.grids[myType];

    const pathFinding = new PathFinding(grid, missiles,
        pos => gridContainer.posToGridPos(pos),
        pos => gridContainer.posToAirmashPos(pos));

    const path = await pathFinding.findPath(myPos, targetPos);
    return path;
}

class PathFinding {

    constructor(
        private grid: number[][],
        private missiles: Missile[],
        private posToGridPos: (pos: Pos) => Pos,
        private posToAirmashPos: (pos: any) => Pos) {
    }

    findPath(firstPos: Pos, targetPos: Pos, ignoreMissiles = false): Promise<Pos[]> {
        return new Promise((resolve, reject) => {
            const easystar = new easystarjs.js();
            easystar.setGrid(this.grid);

            if (!ignoreMissiles) {
                for (const m of this.missiles) {
                    const missilePos = this.posToGridPos(m.pos);
                    easystar.avoidAdditionalPoint(missilePos.x, missilePos.y);
                }
            }

            easystar.setAcceptableTiles([0, 1, 2]);
            easystar.setTileCost(1, 10);
            easystar.setTileCost(2, 50);

            easystar.enableDiagonals();
            easystar.enableCornerCutting();

            const gridFirstPos = this.posToGridPos(firstPos);
            const gridTargetPos = this.posToGridPos(targetPos);

            easystar.findPath(gridFirstPos.x, gridFirstPos.y, gridTargetPos.x, gridTargetPos.y, async path => {
                if (!path) {
                    // try again without missiles
                    if (!ignoreMissiles) {
                        try {
                            const path2 = await this.findPath(firstPos, targetPos, true);
                            resolve(path2);
                        } catch (error) {
                            reject(error)
                        }
                    } else {
                        reject('no path found');
                    }
                    return;
                }
                const airmashPath = path.map(x => this.posToAirmashPos(x));
                const simplifiedAirmashPath = simplifyPath(airmashPath, 100);
                resolve(simplifiedAirmashPath);
            });
            easystar.calculate();
        });
    }
}

workerpool.worker({ doPathFinding });