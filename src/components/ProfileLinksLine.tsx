import { PROFILE_LINK_INFO, PROFILE_LINKS, profileLinkHref, type ProfileLinks } from '@/lib/profile';

/** A person's links in a line under their name: homepage · ORCID · Google Scholar, each only when set. */
export function ProfileLinksLine({ links, className = '' }: { links: ProfileLinks; className?: string }) {
  const set = PROFILE_LINKS.filter((link) => links[link]);
  if (set.length === 0) return null;
  return (
    <p className={`text-center font-sans text-[13px] ${className}`}>
      {set.map((link, i) => (
        <span key={link}>
          {i > 0 && <span className="text-faint"> · </span>}
          <a href={profileLinkHref(link, links[link]!)} rel="me noopener nofollow">
            {PROFILE_LINK_INFO[link].label}
          </a>
        </span>
      ))}
    </p>
  );
}
