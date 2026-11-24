/**
 * Product events for Umami (`window.umami.track`), as acceptodds sends them, for funnels: where people leave
 * sign-up and sign-in, and what they do on a paper once they are in. Page views are counted by the tracker
 * itself (`components/Analytics.tsx`); these are the actions in between.
 *
 * Event data is **not personal, by construction**: only the fields in `EventData`, each a short code, a flag or a
 * small number. Never an email, handle, name, id, query or text someone typed. The page URL is filtered in
 * `lib/analytics.ts` for the same reason, and events must not be a way around it. Add a field only if it is as
 * harmless as the ones already there.
 *
 * Does nothing server-side, before the tracker has loaded (it retries for a few seconds, since the script is added
 * after hydration), or when analytics is off.
 */

export type EventName =
  // /welcome: each step of the tour reached, the address sent or refused
  | 'tour_step'
  | 'signup_submitted'
  | 'signup_refused'
  // /signin, and a reset link's /set-password
  | 'signin_succeeded'
  | 'signin_failed'
  | 'signin_link_requested'
  | 'signin_link_refused'
  | 'password_reset_requested'
  | 'password_set'
  | 'password_set_failed'
  | 'signed_out'
  // the code from the mail (`CodeEntry`)
  | 'code_confirmed'
  | 'code_failed'
  | 'code_resent'
  // /verify-email once confirmed: what is owed, each part of it done, and all of it done or skipped
  | 'finish_shown'
  | 'finish_step'
  | 'finish_completed'
  // the "Confirm your email" banner across the site while a sign-up waits for its code
  | 'confirm_banner_clicked'
  | 'confirm_banner_dismissed'
  // the home page's [getting started] and [onboard your agent]: opened, each step first reached (2 onwards), its
  // last button
  | 'tutorial_opened'
  | 'tutorial_step'
  | 'tutorial_finished'
  // a prompt for an AI agent copied (`target` says where), and an agent's connection answered
  | 'agent_prompt_copied'
  | 'agent_connect_approved'
  | 'agent_connect_declined'
  // following a page, or the sign-in link a signed-out reader gets instead
  | 'follow_toggled'
  | 'follow_signin_clicked'
  // sharing: the popover opened, a link copied (`target`), a service's share page opened
  | 'share_opened'
  | 'share_copied'
  | 'share_sent'
  // reading a paper: its blurred reviews shown, a review's text opened, a comment list opened or shown in full, a
  // section folded or unfolded. PDF and source links are counted by `data-umami-event` on the links themselves
  // ('pdf_opened', 'source_opened').
  | 'reviews_unblurred'
  | 'review_opened'
  | 'review_comments_opened'
  | 'review_comments_more'
  | 'section_toggled'
  // the discussion under a page
  | 'comment_previewed'
  | 'comment_posted'
  | 'comment_failed'
  | 'comment_removed'
  | 'comment_reply_opened'
  // editing: the dialog opened, the web editor opened from it, the clone or extension command copied, a commit made
  // in the web editor, a revert, a picture dropped in
  | 'edit_opened'
  | 'edit_web_opened'
  | 'edit_clone_copied'
  | 'extension_command_copied'
  | 'edit_saved'
  | 'edit_reverted'
  | 'edit_revert_refused'
  | 'picture_added'
  // "Add …?" on a paper (a version, a demo, a picture, …): opened, and "Edit myself" taken instead of the prompt
  | 'missing_opened'
  | 'missing_edit_myself'
  // claiming a paper (or a venue as its organiser): each step done, or refused (`target` names the step)
  | 'claim_step'
  | 'claim_refused'
  // the profile: edited, an institution address added, confirmed or removed, mail settings, keys
  | 'profile_edit_opened'
  | 'profile_saved'
  | 'affiliation_step'
  | 'affiliation_refused'
  | 'mail_setting_changed'
  | 'api_key_created'
  | 'api_key_revoked'
  | 'ssh_key_added'
  // plugins on pages: a frame started (`target` is its surface: 'panel' | 'rows' | 'popover' | 'page' | …), a command
  // run from a panel's ⋯ or a row's, a link it opened, its approval asked on a page and put off; a tab chosen among a
  // page's panels (built-in or a plugin's)
  | 'plugin_started'
  | 'plugin_command_run'
  | 'plugin_link_opened'
  | 'plugin_consent_dismissed'
  | 'tab_opened'
  // managing plugins (`lib/plugins/client.ts`, so from wherever it is done), and settings
  | 'plugin_installed'
  | 'plugin_install_refused'
  | 'plugin_removed'
  | 'plugin_toggled'
  | 'plugin_approved'
  | 'plugin_revoked'
  | 'plugin_updated'
  | 'plugin_dev_added'
  | 'settings_imported'
  // new pages made by hand
  | 'category_created'
  | 'department_created'
  // "Report a problem" followed
  | 'problem_report_opened'
  // the home page's announcements: a link in one followed, or one closed with its ×
  | 'announcement_clicked'
  | 'announcement_dismissed';

export interface EventData {
  /** A refusal or failure: the error code or HTTP status, never its message. */
  reason?: string;
  /** Follow: whether the page is now followed. */
  following?: boolean;
  signedIn?: boolean;
  /** A switch's new state: a plugin turned on, a section unfolded, a comment posted anonymously. */
  on?: boolean;
  needsName?: boolean;
  needsPassword?: boolean;
  /**
   * A short code from our own vocabulary, never anything a person typed: what was copied ('link' | 'badge' |
   * 'invite' | 'review' | 'comment'), a share service ('x' | 'bluesky' | …), where an agent prompt was ('onboard' |
   * 'tutorial' | 'edit' | 'missing' | 'plugins'), a Finish or claim step, a section's slot id, what was missing
   * ('version' | 'demo' | …), a mail setting's field, a picture's file type.
   */
  target?: string;
  /** A tour or tutorial step: the tour's step name, or the tutorial's step counted from 1. */
  step?: number | string;
  /**
   * A plugin's id (`owner/repo` of its public repository): published code, like `announcement`, not a person. A
   * dev plugin's localhost address is never sent.
   */
  plugin?: string;
  /** An announcement's id: the admin's message, about no one. */
  announcement?: string;
}

type Umami = { track: (name: string, data?: Record<string, unknown>) => void };

const ATTEMPTS = 20;
const RETRY_MS = 500;

export function track(name: EventName, data?: EventData, attempt = 0): void {
  if (typeof window === 'undefined') return;
  try {
    const umami = (window as unknown as { umami?: Umami }).umami;
    if (umami) return umami.track(name, data as Record<string, unknown> | undefined);
    // Analytics off or not loaded yet; give the script a few seconds.
    if (attempt < ATTEMPTS) setTimeout(() => track(name, data, attempt + 1), RETRY_MS);
  } catch {
    // Analytics never raises into the page.
  }
}

/** A plugin as events name it: its id, or 'dev' for one served from the reader's own machine, unpublished. */
export function pluginLabel(p: { from: string; plugin?: { id: string } | null }): string | undefined {
  return p.from === 'dev' ? 'dev' : p.plugin?.id;
}
