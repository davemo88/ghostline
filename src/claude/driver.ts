// Claude player driver (§13.1/13.4): at each decision boundary, serialize the
// player's view, call the model, validate the returned commands, apply them.
// The transport is injected so tests (and future scripted bots) never touch
// the network. One API call per decision interval; memory across turns is the
// model-maintained memo string.

import {
  BUILDING_STATS,
  type Behavior,
  type BuildingType,
  type Command,
  type Game,
  type OverrideStance,
  type PlayerId,
  TECHS,
  type TechId,
  UNIT_STATS,
  type UnitType,
  snapshot,
} from '../sim';
import { buildSystemPrompt } from './prompt';

export interface TurnRequest {
  system: string; // stable per match — transports should cache-control this
  user: string; // snapshot + memo
}

export interface TurnResponse {
  memo: string;
  commands: unknown[];
  /** Summarized thinking (when the transport requested it) — debug/spectator UI. */
  thinking?: string;
  /** True when the model refused / errored and the turn should be a no-op. */
  skipped?: boolean;
}

export type Transport = (req: TurnRequest) => Promise<TurnResponse>;

/** JSON schema for the model's structured output ({memo, commands}). */
export const TURN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    memo: {
      type: 'string',
      description: 'Your strategic memory, echoed back to you next turn. Keep under 200 words.',
    },
    commands: {
      type: 'array',
      description: 'Commands to issue this turn, executed in order.',
      items: {
        type: 'object',
        properties: {
          cmd: {
            type: 'string',
            enum: [
              'move',
              'stop',
              'build',
              'resume_build',
              'cancel_build',
              'repair',
              'set_rally',
              'set_behavior',
              'set_production',
              'research',
              'global_override',
            ],
          },
          pos: { type: 'array', items: { type: 'number' }, description: '[x,y] world units' },
          type: { type: 'string', enum: Object.keys(BUILDING_STATS).filter((b) => b !== 'bastion') },
          building: { type: 'integer', description: 'building id' },
          behavior: { type: 'string', enum: ['guard', 'assault', 'hold', 'hunt'] },
          unit: { type: 'string', enum: Object.keys(UNIT_STATS) },
          on: { type: 'boolean' },
          tech: { type: 'string', enum: Object.keys(TECHS) },
          stance: { type: 'string', enum: ['fall_back', 'defend', 'release'] },
          replace: { type: 'boolean' },
        },
        required: ['cmd'],
        additionalProperties: false,
      },
    },
  },
  required: ['memo', 'commands'],
  additionalProperties: false,
} as const;

const BEHAVIORS: Behavior[] = ['guard', 'assault', 'hold', 'hunt'];
const STANCES: OverrideStance[] = ['fall_back', 'defend', 'release'];

/**
 * Shape-validate one raw command from the model. Returns a typed Command or
 * an error string. Semantic legality (costs, adjacency, terrain) is the
 * engine's job — it drops illegal commands and reports them in the next
 * snapshot's invalidCommands, so Claude self-corrects (§13.3).
 */
export function validateCommand(raw: unknown): Command | string {
  if (typeof raw !== 'object' || raw === null) return 'command is not an object';
  const c = raw as Record<string, unknown>;
  const pos = (): [number, number] | string => {
    if (!Array.isArray(c.pos) || c.pos.length !== 2) return 'pos must be [x,y]';
    const [x, y] = c.pos;
    if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) {
      return 'pos must be finite numbers';
    }
    return [x, y];
  };
  const building = (): number | string =>
    typeof c.building === 'number' && Number.isInteger(c.building) ? c.building : 'building must be an id';

  switch (c.cmd) {
    case 'move': {
      const p = pos();
      return typeof p === 'string' ? p : { cmd: 'move', pos: p, replace: c.replace === true };
    }
    case 'stop':
      return { cmd: 'stop' };
    case 'build': {
      const p = pos();
      if (typeof p === 'string') return p;
      const t = c.type as BuildingType;
      if (typeof t !== 'string' || !(t in BUILDING_STATS) || t === 'bastion') return `unknown building type '${c.type}'`;
      return { cmd: 'build', type: t, pos: p };
    }
    case 'resume_build':
    case 'cancel_build':
    case 'repair': {
      const b = building();
      return typeof b === 'string' ? b : { cmd: c.cmd, building: b };
    }
    case 'set_rally': {
      const b = building();
      if (typeof b === 'string') return b;
      const p = pos();
      return typeof p === 'string' ? p : { cmd: 'set_rally', building: b, pos: p };
    }
    case 'set_behavior': {
      const b = building();
      if (typeof b === 'string') return b;
      if (!BEHAVIORS.includes(c.behavior as Behavior)) return `unknown behavior '${c.behavior}'`;
      return { cmd: 'set_behavior', building: b, behavior: c.behavior as Behavior };
    }
    case 'set_production': {
      const b = building();
      if (typeof b === 'string') return b;
      if (c.unit !== undefined && !(typeof c.unit === 'string' && c.unit in UNIT_STATS)) {
        return `unknown unit '${c.unit}'`;
      }
      return {
        cmd: 'set_production',
        building: b,
        unit: c.unit as UnitType | undefined,
        on: typeof c.on === 'boolean' ? c.on : undefined,
      };
    }
    case 'research': {
      if (!(typeof c.tech === 'string' && c.tech in TECHS)) return `unknown tech '${c.tech}'`;
      return { cmd: 'research', tech: c.tech as TechId };
    }
    case 'global_override': {
      if (!STANCES.includes(c.stance as OverrideStance)) return `unknown stance '${c.stance}'`;
      return { cmd: 'global_override', stance: c.stance as OverrideStance };
    }
    default:
      return `unknown cmd '${String(c.cmd)}'`;
  }
}

export interface TurnResult {
  commands: Command[];
  rejected: { raw: unknown; reason: string }[];
  memo: string;
  thinking: string;
  skipped: boolean;
}

export interface TurnRecord extends TurnResult {
  turn: number;
  gameTime: number; // seconds
}

export class ClaudePlayer {
  readonly player: PlayerId;
  readonly decisionInterval: number; // seconds
  memo = '';
  turns = 0;
  /** Recent turns for debug/spectator UI (newest last, capped). */
  history: TurnRecord[] = [];
  private transport: Transport;
  private systemPrompt: string | null = null;

  constructor(player: PlayerId, transport: Transport, decisionInterval = 10) {
    this.player = player;
    this.transport = transport;
    this.decisionInterval = decisionInterval;
  }

  /**
   * Run one decision turn: snapshot -> model -> validate -> apply.
   * Call with the sim paused at a decision boundary.
   */
  async takeTurn(game: Game): Promise<TurnResult> {
    if (this.systemPrompt === null) {
      this.systemPrompt = buildSystemPrompt(game, this.decisionInterval);
    }
    const snap = snapshot(game, this.player, this.decisionInterval);
    const user = JSON.stringify({
      snapshot: snap,
      memo: this.memo || '(first turn — no memo yet)',
    });

    const res = await this.transport({ system: this.systemPrompt, user });
    this.turns++;
    const record = (r: TurnResult): TurnResult => {
      this.history.push({ ...r, turn: this.turns, gameTime: game.gameTime });
      if (this.history.length > 40) this.history.shift();
      return r;
    };

    if (res.skipped) {
      return record({ commands: [], rejected: [], memo: this.memo, thinking: '', skipped: true });
    }
    this.memo = typeof res.memo === 'string' ? res.memo.slice(0, 4000) : this.memo;

    const commands: Command[] = [];
    const rejected: { raw: unknown; reason: string }[] = [];
    const list = Array.isArray(res.commands) ? res.commands.slice(0, 30) : [];
    for (const raw of list) {
      const v = validateCommand(raw);
      if (typeof v === 'string') rejected.push({ raw, reason: v });
      else commands.push(v);
    }

    game.applyCommands(this.player, commands);
    // Malformed commands never reached the engine; surface them the same way
    // engine-rejected commands are surfaced (next snapshot's invalidCommands).
    for (const r of rejected) {
      game.players[this.player].invalid.push({ cmd: 'malformed', reason: r.reason });
    }
    return record({
      commands,
      rejected,
      memo: this.memo,
      thinking: typeof res.thinking === 'string' ? res.thinking : '',
      skipped: false,
    });
  }
}
