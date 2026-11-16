'use client';

import { useMemo, useRef, useState } from 'react';
import { ui } from '@/components/ui';
import {
  checkSettings,
  CORE_SETTINGS,
  formatProblem,
  isEditable,
  parseSettings,
  resolveSettings,
  sameValue,
  setInSettings,
  type CoreSetting,
  type SettingsProblem,
} from '@/lib/settings';
import { SettingsError, saveSettings, useSettings } from '@/lib/settings/client';

type Note = { ok: boolean; text: string } | null;

/** The settings form, the raw settings.json, and Export and Import. */
export function SettingsEditor() {
  const settings = useSettings();
  const [view, setView] = useState<'form' | 'json'>('form');
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  if (!settings.loaded) return <p className={ui.empty}>Loading your settings…</p>;

  function exportFile() {
    const url = URL.createObjectURL(new Blob([settings.text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'settings.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importFile(file: File) {
    // Into the editor, to look over before saving: an import replaces the whole file.
    setDraft(await file.text());
    setView('json');
    setNote({ ok: true, text: `Loaded ${file.name}. Look it over, then save it to replace your settings.` });
  }

  return (
    <div className="font-sans text-sm">
      <p className="mb-4 text-muted">
        {settings.signedIn ? (
          <>Your settings follow your account.</>
        ) : (
          <>
            You aren&apos;t signed in, so these settings are kept in this browser. When you sign in, you can keep them
            in your account.
          </>
        )}{' '}
        They are one file, <code className={ui.mono}>settings.json</code>, which holds only what you changed from the
        site&apos;s defaults.
      </p>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule pb-2">
        <button className={view === 'form' ? ui.on : ui.linkBtn} onClick={() => setView('form')}>
          Settings
        </button>
        <button className={view === 'json' ? ui.on : ui.linkBtn} onClick={() => setView('json')}>
          Edit settings.json
        </button>
        <span className="flex-1" />
        <button className={ui.linkBtn} onClick={exportFile}>
          Export
        </button>
        <button className={ui.linkBtn} onClick={() => fileInput.current?.click()}>
          Import
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,.jsonc,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void importFile(file);
          }}
        />
      </div>
      {note && <p className={`${ui.note(note.ok)} mb-3`}>{note.text}</p>}
      {view === 'form' ? (
        <SettingsForm text={settings.text} siteText={settings.siteText} onNote={setNote} />
      ) : (
        <RawEditor
          saved={settings.text}
          draft={draft ?? settings.text}
          onDraft={setDraft}
          onSaved={() => setDraft(null)}
          onNote={setNote}
        />
      )}
    </div>
  );
}

/** Save a whole new text, saying how it went. */
async function save(text: string, onNote: (n: Note) => void): Promise<boolean> {
  try {
    const warnings = await saveSettings(text);
    onNote({ ok: true, text: warnings.length ? `Saved, with ${plural(warnings.length, 'warning')}.` : 'Saved.' });
    return true;
  } catch (err) {
    onNote({ ok: false, text: err instanceof SettingsError ? err.message : 'Could not save your settings.' });
    return false;
  }
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * A form made from the core settings' schema (`lib/settings/core.ts`), one group at a time. Each change edits one
 * key of the file, keeping the rest as written, and a value equal to the layer below is taken out of it.
 */
function SettingsForm({ text, siteText, onNote }: { text: string; siteText: string; onNote: (n: Note) => void }) {
  const below = useMemo(() => resolveSettings({ site: parseSettings(siteText) }), [siteText]);
  const values = useMemo(
    () => resolveSettings({ site: parseSettings(siteText), user: parseSettings(text) }),
    [siteText, text],
  );
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => {
    const out = new Map<string, [string, CoreSetting][]>();
    for (const entry of Object.entries(CORE_SETTINGS)) {
      const list = out.get(entry[1].group) ?? [];
      list.push(entry);
      out.set(entry[1].group, list);
    }
    return [...out];
  }, []);

  if (!isEditable(text)) {
    return (
      <p className={ui.note(false)}>
        Your settings.json doesn&apos;t parse, so the form can&apos;t change it. Fix it under “Edit settings.json”.
      </p>
    );
  }

  async function change(key: string, value: unknown) {
    setBusy(true);
    const next = setInSettings(text, key, sameValue(value, below[key]) ? undefined : value);
    await save(next, onNote);
    setBusy(false);
  }

  return groups.map(([group, entries]) => (
    <section key={group} className="mb-6">
      <h2 className={ui.sectionHeading}>{group}</h2>
      {entries.map(([key, setting]) => (
        <fieldset key={key} className="mb-5 max-w-[520px]" disabled={busy}>
          <legend className="font-semibold">{setting.title}</legend>
          <p className={`${ui.fine} mt-0 mb-2`}>
            {setting.description} <code className="font-mono">{key}</code>
            {Object.hasOwn(parseSettings(text), key) && (
              <>
                {' · '}
                <button className={ui.linkBtn} onClick={() => change(key, below[key])}>
                  reset
                </button>
              </>
            )}
          </p>
          <SettingField setting={setting} value={values[key]} onChange={(v) => change(key, v)} />
        </fieldset>
      ))}
    </section>
  ));
}

const NO_CHOICES: NonNullable<CoreSetting['choices']> = [];

/** One setting's control, chosen by its schema's widget. */
function SettingField({
  setting,
  value,
  onChange,
}: {
  setting: CoreSetting;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const choices = setting.choices ?? NO_CHOICES;
  const list = Array.isArray(value) ? (value as string[]) : [];
  const grouped = useMemo(() => {
    const out = new Map<string, typeof choices>();
    for (const c of choices) out.set(c.group ?? '', [...(out.get(c.group ?? '') ?? []), c]);
    return [...out];
  }, [choices]);

  if (setting.widget === 'toggles') {
    // A box per choice, ticked when it is shown: the setting lists the ones left out.
    return grouped.map(([group, items]) => (
      <div key={group} className="mb-2">
        {group && <div className="text-xs text-muted">{group}</div>}
        {items.map((c) => (
          <label key={c.value} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!list.includes(c.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? list.filter((v) => v !== c.value)
                    : choices.map((x) => x.value).filter((v) => v === c.value || list.includes(v)),
                )
              }
            />
            {c.label}
          </label>
        ))}
      </div>
    ));
  }

  if (setting.widget === 'order') {
    // Within each group, those the setting names first, then the rest in their usual order.
    const ranked = (items: typeof choices) => {
      const rank = (v: string) =>
        list.includes(v) ? list.indexOf(v) : list.length + choices.findIndex((c) => c.value === v);
      return items.toSorted((a, b) => rank(a.value) - rank(b.value));
    };
    const move = (items: typeof choices, at: number, by: number) => {
      const order = ranked(items).map((c) => c.value);
      [order[at], order[at + by]] = [order[at + by], order[at]];
      // The whole new order of this group, over what the setting says of the others.
      const others = list.filter((v) => !order.includes(v));
      onChange([...others, ...order]);
    };
    return grouped.map(([group, items]) => (
      <div key={group} className="mb-2">
        {group && <div className="text-xs text-muted">{group}</div>}
        <ol>
          {ranked(items).map((c, i, all) => (
            <li key={c.value} className="flex items-baseline gap-2">
              <span className="w-4 text-right text-faint tabular-nums">{i + 1}.</span>
              <span className="flex-1">{c.label}</span>
              <button
                className={ui.linkBtn}
                disabled={i === 0}
                aria-label={`Move ${c.label} up`}
                onClick={() => move(items, i, -1)}
              >
                ↑
              </button>
              <button
                className={ui.linkBtn}
                disabled={i === all.length - 1}
                aria-label={`Move ${c.label} down`}
                onClick={() => move(items, i, 1)}
              >
                ↓
              </button>
            </li>
          ))}
        </ol>
      </div>
    ));
  }

  return <p className={ui.fine}>Change this one under “Edit settings.json”.</p>;
}

/**
 * The file itself, as written: comments and order are kept. Checked as you type, with the same checks the server
 * makes (it checks again on saving, against your installed plugins' settings too).
 */
function RawEditor({
  saved,
  draft,
  onDraft,
  onSaved,
  onNote,
}: {
  saved: string;
  draft: string;
  onDraft: (text: string | null) => void;
  onSaved: () => void;
  onNote: (n: Note) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const problems = useMemo(() => checkSettings(draft), [draft]);
  const errors = problems.filter((p) => p.severity === 'error');
  const changed = draft !== saved;

  function goTo(p: SettingsProblem) {
    const el = area.current;
    if (!el) return;
    const lines = draft.split('\n');
    const start = lines.slice(0, p.line - 1).reduce((n, l) => n + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(start, start + (lines[p.line - 1]?.length ?? 0));
  }

  return (
    <div>
      <textarea
        ref={area}
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          // Tab indents, as in an editor, rather than leaving the field.
          if (e.key !== 'Tab' || e.shiftKey) return;
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart: s, selectionEnd: end } = el;
          onDraft(`${draft.slice(0, s)}  ${draft.slice(end)}`);
          requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
        }}
        spellCheck={false}
        aria-label="settings.json"
        rows={Math.min(30, Math.max(8, draft.split('\n').length + 2))}
        className={`${ui.input} font-mono text-[13px] narrow:text-base`}
      />
      {problems.length > 0 && (
        <ul className="mb-2 font-mono text-xs">
          {problems.map((p, i) => (
            <li key={i}>
              <button
                className={`cursor-pointer text-left ${p.severity === 'error' ? 'text-down' : 'text-muted'}`}
                onClick={() => goTo(p)}
              >
                {p.severity === 'error' ? 'error' : 'warning'} (line {p.line}) {formatProblem(p)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-baseline gap-4">
        <button
          className={ui.btn({ inline: true })}
          disabled={busy || !changed || errors.length > 0}
          onClick={async () => {
            setBusy(true);
            if (await save(draft, onNote)) onSaved();
            setBusy(false);
          }}
        >
          Save
        </button>
        {changed && (
          <button className={ui.linkBtn} disabled={busy} onClick={() => onDraft(null)}>
            Discard changes
          </button>
        )}
        <span className={`${ui.fine} mt-0`}>
          JSON with comments. Its schema is <a href="/schemas/settings.json">/schemas/settings.json</a>; agents and
          scripts read and write it at <code className="font-mono">/api/v1/me/settings</code>.
        </span>
      </div>
    </div>
  );
}
