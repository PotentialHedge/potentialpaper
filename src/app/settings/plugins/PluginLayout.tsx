'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Select, Switch } from '@/components/controls';
import { ui } from '@/components/ui';
import { PANEL_KINDS, type PanelKind } from '@/lib/panels';
import { type InstalledPlugin, pluginPanelChoices } from '@/lib/plugins/installed';
import { pluginPanelId } from '@/lib/plugins/manifest';
import { isEditable, parseSettings, resolveSettings, sameValue, setInSettings } from '@/lib/settings';
import { saveSettings, settingsSnapshot, useSettings } from '@/lib/settings/client';
import { CORE_SETTINGS } from '@/lib/settings/core';
import { kindCategory, panelsSettingsPath } from '@/lib/settings/form';

/**
 * A plugin's Layout: for each of its panels, on each kind of page it is on, where it goes and whether it shows. These
 * are the same settings the kind's Panels control edits (`<kind>.panels.placement`, `<kind>.panels.hidden`); the
 * order within a place is set there, which each kind's name links to.
 */
export function PluginLayout({ plugin }: { plugin: InstalledPlugin }) {
  const settings = useSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const below = useMemo(
    () => resolveSettings({ site: parseSettings(settings.siteText) }, settings.plugins),
    [settings.siteText, settings.plugins],
  );
  if (!plugin.plugin) return null;
  const { id, manifest } = plugin.plugin;
  const titles = new Map(manifest.contributes.panels.map((p) => [pluginPanelId(id, p.id), p.title]));
  // Each panel's rows, one per kind of page; panels of one name (one per kind) together.
  const panels = new Map<string, { kind: PanelKind; choice: ReturnType<typeof pluginPanelChoices>[number] }[]>();
  for (const kind of PANEL_KINDS) {
    for (const choice of pluginPanelChoices([plugin], kind)) {
      const title = titles.get(choice.value) ?? choice.value;
      panels.set(title, [...(panels.get(title) ?? []), { kind, choice }]);
    }
  }
  const pages = manifest.contributes.pages;
  if (panels.size === 0 && pages.length === 0) return null;

  const value = <T,>(key: string, fallback: T): T => (settings.values[key] as T | undefined) ?? fallback;
  async function save(key: string, next: unknown) {
    setBusy(true);
    setError(null);
    try {
      const base = Object.hasOwn(below, key) ? below[key] : CORE_SETTINGS[key]?.default;
      await saveSettings(setInSettings(settingsSnapshot().text, key, sameValue(next, base) ? undefined : next));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const editable = settings.loaded && isEditable(settings.text);

  return (
    <>
      <h3 className="mt-8 mb-2 font-serif text-lg font-normal">Layout</h3>
      {[...panels].map(([title, rows]) => (
        <div key={title} className="mb-4">
          {panels.size > 1 && <h4 className="mb-1 font-semibold">{title}</h4>}
          <div className="grid max-w-[560px] grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
            {rows.map(({ kind, choice }) => {
              const placementKey = `${kind}.panels.placement`;
              const hiddenKey = `${kind}.panels.hidden`;
              const placement = value<Record<string, string>>(placementKey, {});
              const hidden = value<string[]>(hiddenKey, []);
              const places = choice.places ?? [];
              const place = places.find((p) => p.value === placement[choice.value]) ?? places[0];
              const shown = !hidden.includes(choice.value);
              return (
                <div key={kind} className="contents">
                  <Link
                    href={panelsSettingsPath(kind)}
                    className="text-ink"
                    title={`All panels on ${kindCategory(kind).title.toLowerCase()}`}
                  >
                    {kindCategory(kind).title}
                  </Link>
                  {places.length > 1 ? (
                    <Select
                      options={places.map((p) => ({ value: p.value, label: p.label }))}
                      value={place?.value ?? ''}
                      onValueChange={(next) => {
                        const { [choice.value]: _old, ...rest } = placement;
                        void _old;
                        // The first place is where it goes anyway, so it isn't written.
                        save(placementKey, next === places[0].value ? rest : { ...rest, [choice.value]: next });
                      }}
                      label={`Where ${title} goes on ${kindCategory(kind).title.toLowerCase()}`}
                      disabled={!editable || busy}
                      className="w-full min-w-0! py-0.5"
                    />
                  ) : (
                    <span className="text-muted">{choice.group}</span>
                  )}
                  <Switch
                    checked={shown}
                    onCheckedChange={(on) =>
                      save(hiddenKey, on ? hidden.filter((v) => v !== choice.value) : [...hidden, choice.value])
                    }
                    aria-label={`Show ${title} on ${kindCategory(kind).title.toLowerCase()}`}
                    disabled={!editable || busy}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {pages.map((page) => (
        <p key={page.id}>
          Its page:{' '}
          <Link href={`/x/${id}/${page.id}`} className="text-accent">
            {page.title}
          </Link>
        </p>
      ))}
      {panels.size > 0 && (
        <p className={ui.fine}>To change a panel&apos;s order, open the kind of page it&apos;s on.</p>
      )}
      {error && <p className={`${ui.note(false)} whitespace-pre-line`}>{error}</p>}
    </>
  );
}
