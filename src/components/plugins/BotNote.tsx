import type { PluginBot } from '@/lib/plugins/installed';
import { ui } from '@/components/ui';

/**
 * Where a plugin's data on pages comes from (`handoffs/plugins.md` Phase 5): the bot its manifest names, and what this
 * site lets that bot write. Naming a bot grants the plugin nothing, so this only says what the plugin shows.
 */
export function BotNote({ bot }: { bot: PluginBot | null | undefined }) {
  if (!bot) return null;
  if (!bot.known) {
    return (
      <li>
        Says it shows data written by <span className={ui.mono}>@{bot.handle}</span>, but this site has no bot by that
        name, so nothing it shows on pages comes from one
      </li>
    );
  }
  return (
    <li>
      Shows data that the bot <span className={ui.mono}>@{bot.handle}</span> writes on pages
      {bot.grants.length > 0 ? (
        <>
          , which this site lets it write to{' '}
          {bot.grants.map((g, i) => (
            <span key={`${g.kind}:${g.pattern}`}>
              {i > 0 && ', '}
              <code className="text-xs">{g.pattern}</code> on {g.kind} pages
            </span>
          ))}
        </>
      ) : (
        ', which this site has not let write anything yet'
      )}
    </li>
  );
}
