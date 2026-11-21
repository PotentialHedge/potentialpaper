'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ui } from '@/components/ui';
import { pluginNavItems } from '@/lib/nav';
import { pluginActions } from '@/lib/page-actions';
import type { PanelKind } from '@/lib/panels';
import { usePlugins } from '@/lib/plugins/client';
import { type InstalledPlugin, pluginPanelChoices } from '@/lib/plugins/installed';
import { isEditable, parseSettings, resolveSettings, sameValue, setInSettings } from '@/lib/settings';
import { saveSettings, settingsSnapshot, useSettings } from '@/lib/settings/client';
import {
  CATEGORIES,
  coreItems,
  itemKeys,
  pluginCategory,
  pluginItems,
  pluginSettingsPath,
  type SettingItem,
} from '@/lib/settings/form';
import { SettingControl } from './controls';

/** A page of the settings: a core category, or a plugin's settings. */
export interface SettingsPage {
  id: string;
  title: string;
  href: string;
  section: 'Pages' | 'Account' | 'Plugins';
  /** The plugin, for a plugin's page. */
  plugin?: InstalledPlugin;
}

/** The plugins whose settings get a page: those with a manifest, once each. */
export function pluginsWithPages(plugins: InstalledPlugin[]): InstalledPlugin[] {
  const seen = new Set<string>();
  return plugins.filter((p) => {
    if (!p.plugin || seen.has(p.plugin.id)) return false;
    seen.add(p.plugin.id);
    return true;
  });
}

/** Every setting the form shows the reader, the pages they are on, and whether the reader is signed in. */
export function useSettingItems() {
  const settings = useSettings();
  const { plugins, loaded: pluginsLoaded } = usePlugins(null);
  const signedIn = settings.loaded && settings.signedIn;
  return useMemo(() => {
    const withPages = pluginsWithPages(plugins);
    const pages: SettingsPage[] = [
      ...CATEGORIES.filter((c) => !c.signedInOnly || signedIn).map((c): SettingsPage => ({
        id: c.id,
        title: c.title,
        href: `/settings/${c.id}`,
        section: c.section,
      })),
      ...withPages.map((p): SettingsPage => ({
        id: pluginCategory(p.plugin!.id),
        title: p.plugin!.manifest.name,
        href: pluginSettingsPath(p.plugin!.id),
        section: 'Plugins',
        plugin: p,
      })),
    ];
    const shown = new Set(pages.map((p) => p.id));
    const items = [
      ...coreItems((list) =>
        list === 'navbar'
          ? pluginNavItems(plugins).map((i) => ({ value: i.id, label: `${i.title} (${i.plugin})` }))
          : list.endsWith('.actions')
            ? pluginActions(plugins, { kind: list.split('.')[0] as PanelKind }).map((a) => ({
                value: a.id,
                label: `${a.title} (${a.plugin})`,
              }))
            : pluginPanelChoices(plugins, list.split('.')[0] as PanelKind),
      ),
      ...withPages.flatMap((p) => pluginItems(p.plugin!.id, p.plugin!.manifest.contributes.settings)),
    ].filter((item) => shown.has(item.category));
    return { items, pages, signedIn, loaded: settings.loaded && pluginsLoaded, plugins };
  }, [plugins, signedIn, settings.loaded, pluginsLoaded]);
}

/**
 * Settings as rows, under their `group` headings. `prefix` puts each one's page before its title, as a search's
 * results do ("Paper pages: Hidden panels").
 */
export function SettingsList({
  items,
  pageOf,
}: {
  items: SettingItem[];
  /** The page each item is on, to name and link it before its title. */
  pageOf?: (item: SettingItem) => SettingsPage | undefined;
}) {
  const settings = useSettings();
  const own = useMemo(() => parseSettings(settings.text), [settings.text]);
  const below = useMemo(
    () => resolveSettings({ site: parseSettings(settings.siteText) }, settings.plugins),
    [settings.siteText, settings.plugins],
  );

  if (!settings.loaded) return <p className={ui.empty}>Loading your settings…</p>;
  if (!isEditable(settings.text)) {
    return (
      <p className={ui.note(false)}>
        Your settings.json doesn&apos;t parse, so these can&apos;t be changed here. Download it, fix it in your editor,
        and upload it.
      </p>
    );
  }

  const groups = new Map<string, SettingItem[]>();
  for (const item of items) groups.set(item.group ?? '', [...(groups.get(item.group ?? '') ?? []), item]);

  const valueOf = (item: SettingItem, key: string) => {
    const base = Object.hasOwn(below, key) ? below[key] : key === item.key ? item.fallback : undefined;
    const set = Object.hasOwn(own, key);
    const value = Object.hasOwn(settings.values, key)
      ? settings.values[key]
      : set && item.read && key === item.key
        ? (item.read(own[key]) ?? base)
        : base;
    return { base, set, value };
  };

  return [...groups].map(([group, list]) => (
    <section key={group} className="mb-2">
      {group && <h3 className="mt-6 mb-1 font-sans text-sm font-semibold text-ink">{group}</h3>}
      {list.map((item) => {
        const keys = Object.fromEntries(itemKeys(item).map((k) => [k, valueOf(item, k)]));
        return <SettingRow key={item.key} item={item} keys={keys} page={pageOf?.(item)} />;
      })}
    </section>
  ));
}

type KeyState = { base: unknown; set: boolean; value: unknown };

/**
 * One setting, as VS Code's editor draws one: its title, what it does, its control and its key. A bar on the left
 * marks one the reader's file sets, with a way back to the default. Each change is saved at once, and a value equal
 * to the layer below is taken out of the file. A control may edit two keys (a kind's panels: their order and which
 * are hidden); the row then reads, marks and resets both.
 */
function SettingRow({
  item,
  keys,
  page,
}: {
  item: SettingItem;
  /** Each key the item edits, with its value, the value below it, and whether the reader's file sets it. */
  keys: Record<string, KeyState>;
  page?: SettingsPage;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const row = useRef<HTMLDivElement>(null);
  // A link to this setting (`/settings/paper#paper.panels.order`): the list renders after the settings load, too late
  // for the browser to scroll to it, so it scrolls here.
  useEffect(() => {
    if (decodeURIComponent(window.location.hash.slice(1)) === item.key) row.current?.scrollIntoView({ block: 'start' });
  }, [item.key]);
  const modified = Object.values(keys).some((k) => k.set);

  /** Save new values for some of the item's keys at once, each taken out of the file when it equals the layer below. */
  async function save(changes: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      let text = settingsSnapshot().text;
      for (const [key, next] of Object.entries(changes)) {
        text = setInSettings(text, key, sameValue(next, keys[key].base) ? undefined : next);
      }
      await saveSettings(text);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const control = (
    <SettingControl
      control={item.control}
      value={keys[item.key].value}
      onChange={(v) => save({ [item.key]: v })}
      values={Object.fromEntries(Object.entries(keys).map(([k, s]) => [k, s.value]))}
      onChangeKey={(k, v) => save({ [k]: v })}
      onChangeWith={(v, others) => save({ [item.key]: v, ...others })}
      label={item.title}
      disabled={busy}
    />
  );
  const description = item.description && <span className="text-subtle">{item.description}</span>;

  return (
    <div
      ref={row}
      id={item.key}
      className={`group/row relative -ml-4 scroll-mt-4 border-l-2 py-3 pl-[14px] hover:bg-highlight/40 ${modified ? 'border-accent' : 'border-transparent'}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h4 className="font-semibold text-ink">
          {page && (
            <Link href={page.href} className="font-normal text-muted">
              {page.title}:{' '}
            </Link>
          )}
          {item.title}
        </h4>
        {modified && (
          <>
            <span className="text-xs text-accent">Modified</span>
            <button
              type="button"
              className={`${ui.linkBtn} text-xs`}
              disabled={busy}
              onClick={() => save(Object.fromEntries(Object.entries(keys).map(([k, s]) => [k, s.base])))}
            >
              Reset to default
            </button>
          </>
        )}
      </div>
      {item.control.kind === 'switch' ? (
        <label className="mt-1 flex cursor-pointer items-start gap-2.5">
          {control}
          {description || <span className="text-subtle">On</span>}
        </label>
      ) : (
        <>
          {description && <p className="mt-0.5 mb-2">{description}</p>}
          {control}
        </>
      )}
      <p className="mt-1.5 font-mono text-[11px] text-faint opacity-0 transition-opacity group-hover/row:opacity-100 narrow:opacity-100">
        {Object.keys(keys).join(' · ')}
      </p>
      {error && <p className={`${ui.note(false)} whitespace-pre-line`}>{error}</p>}
    </div>
  );
}
