'use client';

import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { ui } from '@/components/ui';
import { usePlugins } from '@/lib/plugins/client';
import type { Connection } from '@/lib/plugins/host';
import { runningPermissions } from '@/lib/plugins/installed';
import type { RowCommand } from '@/lib/plugins/manifest';
import type { RowList, RowNote as Note } from '@/lib/plugins/protocol';
import { pluginSettingsPath } from '@/lib/settings/form';
import { PluginFrame, type ReadyPlugin } from './PluginFrame';

/**
 * Plugins on the rows of a list of papers (DESIGN.md §10, `contributes.rows`): each plugin that adds to rows runs one
 * hidden frame for the whole list, told the papers listed (`pp.rows.papers`, and `rows.change`), and sets a short note
 * on any of them (`pp.rows.set`), which the row shows where it shows the venue (`RowNote`). Its row commands go in each
 * row's ⋯ menu (`RowActions`): run in that frame, or with `popover`, in a frame of their own beside the row. The host
 * draws everything; a plugin gives text. The list's HTML is the same for every reader, so all of this comes after
 * load, and a reader without such plugins gets the list as it was.
 */

interface Placed {
  plugin: ReadyPlugin;
  note: Note;
}

interface RowsState {
  list: RowList;
  plugins: ReadyPlugin[];
  viewer: { signedIn: boolean; isOwner: boolean };
  /** The notes on a paper's row, in install order: the first is shown, the rest are in its tooltip. */
  notesFor(paper: string): Placed[];
  setNotes(pluginId: string, notes: Record<string, Note | null>): void;
  /** Run a row command that has no popover, in its plugin's list frame. */
  run(pluginId: string, command: string, paper: string): Promise<void>;
}

const RowsContext = createContext<RowsState | null>(null);

/** A plugin that adds to rows and may run here: ready, and allowed to see the list. */
function addsToRows(p: ReturnType<typeof usePlugins>['plugins'][number]): p is ReadyPlugin {
  return (
    p.status === 'ready' &&
    !!p.plugin?.manifest.contributes.rows &&
    runningPermissions(p as ReadyPlugin).includes('lists.read')
  );
}

export function RowPlugins({ list, papers, children }: { list: RowList; papers: string[]; children: ReactNode }) {
  const { plugins: all, viewer } = usePlugins(null);
  const plugins = useMemo(() => all.filter(addsToRows), [all]);
  const waiting = all.filter((p) => p.status === 'consent' && p.plugin?.manifest.contributes.rows);
  const [notes, setAllNotes] = useState<Record<string, Record<string, Note>>>({});
  const connections = useRef(new Map<string, Connection | null>());
  // The same list, the same array: the frames are only told when it changes.
  const papersKey = papers.join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const listed = useMemo(() => papers, [papersKey]);

  const setNotes = useCallback((pluginId: string, patch: Record<string, Note | null>) => {
    setAllNotes((prev) => {
      const own = { ...prev[pluginId] };
      for (const [paper, note] of Object.entries(patch)) {
        if (note === null) delete own[paper];
        else own[paper] = note;
      }
      return { ...prev, [pluginId]: own };
    });
  }, []);

  const state = useMemo<RowsState>(
    () => ({
      list,
      plugins,
      viewer,
      notesFor: (paper) =>
        plugins.flatMap((plugin) => {
          const note = notes[plugin.plugin.id]?.[paper];
          return note ? [{ plugin, note }] : [];
        }),
      setNotes,
      run: async (pluginId, command, paper) => {
        const connection = connections.current.get(pluginId);
        if (!connection) throw new Error("the plugin hasn't started yet");
        await connection.call('commands.run', { command, args: { paper } });
      },
    }),
    [list, plugins, viewer, notes, setNotes],
  );

  const hasCommands = plugins.some((p) => (p.plugin.manifest.contributes.rows?.commands.length ?? 0) > 0);
  // Rows leave room for their ⋯ only when there is a menu to open (`PaperRow`'s last column).
  const style = hasCommands ? ({ '--row-actions': '22px' } as CSSProperties) : undefined;
  return (
    <RowsContext.Provider value={state}>
      {waiting.map((p) => (
        <p key={p.plugin!.id} className="mt-2 font-sans text-xs text-muted">
          {p.plugin!.manifest.name} asks before it adds notes to this list.{' '}
          <a href={pluginSettingsPath(p.plugin!.id)}>Review it</a>
        </p>
      ))}
      <div style={style}>{children}</div>
      {plugins.map((p) => (
        <PluginFrame
          key={`${p.plugin.id}@${p.plugin.commit}`}
          hidden
          plugin={p}
          surface={{ type: 'rows', id: 'rows', list, papers: listed }}
          page={null}
          viewer={viewer}
          title={`${p.plugin.manifest.contributes.rows?.title ?? p.plugin.manifest.name} (${p.plugin.manifest.name})`}
          onConnect={(c) => connections.current.set(p.plugin.id, c)}
          onRowNotes={(n) => setNotes(p.plugin.id, n)}
        />
      ))}
    </RowsContext.Provider>
  );
}

const TONES: Record<NonNullable<Note['tone']>, string> = {
  muted: 'text-muted',
  up: 'text-up',
  down: 'text-down',
  accent: 'text-accent',
};

/**
 * What a row shows where it shows the venue: the first plugin's note on the paper, or else `children` (the venue).
 * Its tooltip has every plugin's note, each with its plugin's name, and the venue.
 */
export function RowNote({ paper, venue, children }: { paper: string; venue: string | null; children: ReactNode }) {
  const rows = useContext(RowsContext);
  const placed = rows?.notesFor(paper) ?? [];
  if (placed.length === 0) return children;
  const title = [
    ...placed.map(({ plugin, note }) => `${note.title ?? note.text} (${plugin.plugin.manifest.name})`),
    ...(venue ? [venue] : []),
  ].join('\n');
  return (
    <span className={TONES[placed[0].note.tone ?? 'muted']} title={title}>
      {placed[0].note.text}
    </span>
  );
}

/**
 * A row's ⋯ menu of its plugins' row commands, or nothing when no plugin has one. A command with `popover` opens its
 * plugin's frame in the menu's place, told the command and the paper; it closes on `ui.close`, Escape or a click away.
 */
export function RowActions({ paper, className = '' }: { paper: string; className?: string }) {
  const rows = useContext(RowsContext);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<{ plugin: ReadyPlugin; command: RowCommand } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!rows) return null;
  const entries = rows.plugins.flatMap((plugin) =>
    (plugin.plugin.manifest.contributes.rows?.commands ?? []).map((command) => ({ plugin, command })),
  );
  if (entries.length === 0) return null;
  const several = new Set(entries.map((e) => e.plugin.plugin.id)).size > 1;

  async function pick(plugin: ReadyPlugin, command: RowCommand) {
    setError(null);
    if (command.popover) {
      setActive({ plugin, command });
      return;
    }
    try {
      await rows!.run(plugin.plugin.id, command.id, paper);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setActive(null);
          setError(null);
        }
      }}
    >
      <PopoverTrigger
        type="button"
        title="Plugins' actions on this paper"
        aria-label="Plugins' actions on this paper"
        className={`relative z-10 cursor-pointer px-1 font-sans text-sm leading-none text-faint hover:text-accent ${className}`}
      >
        ⋯
      </PopoverTrigger>
      <PopoverContent menu={!active} align="end" className="text-[13px]">
        {active ? (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs text-faint">
              <span className={ui.runIn}>{active.command.title}</span>
              <span>{active.plugin.plugin.manifest.name}</span>
            </div>
            <PluginFrame
              plugin={active.plugin}
              surface={{ type: 'popover', id: active.command.id, list: rows.list, paper }}
              page={null}
              viewer={rows.viewer}
              title={`${active.command.title} (${active.plugin.plugin.manifest.name})`}
              onRowNotes={(n) => rows.setNotes(active.plugin.plugin.id, n)}
              onClose={() => {
                setOpen(false);
                setActive(null);
              }}
            />
          </>
        ) : (
          <>
            {entries.map(({ plugin, command }) => (
              <button
                key={`${plugin.plugin.id}.${command.id}`}
                type="button"
                className={`${ui.linkBtn} text-left`}
                onClick={() => pick(plugin, command)}
              >
                {command.title}
                {command.popover && '…'}
                {several && <span className="text-faint"> · {plugin.plugin.manifest.name}</span>}
              </button>
            ))}
            {error && <span className="text-accent">{error}</span>}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
