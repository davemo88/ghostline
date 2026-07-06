// Public surface of the sim core. Presentation and the Claude driver import
// only from here — never from internals.

export * from './constants';
export { Game } from './game';
export type {
  AttackEvent,
  ShellState,
  ShellEvent,
  BurstEvent,
  Command,
  CommanderEnt,
  BuildingEnt,
  UnitEnt,
  Entity,
  PlayerId,
  PlayerState,
  CapturePointState,
} from './game';
export { junction9, cellIndex, posToCell, cellCenter } from './map';
export type { GameMap } from './map';
export { snapshot, mapInfo, availableTechs } from './snapshot';
export type { Vec } from './math';
