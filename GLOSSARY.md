# jspratt.dev

Josh Spratt's personal homepage: a professional calling card that grows to hold projects and writing.

## Language

**Homepage**:
The single page at `/`, made of the Intro, Projects and (once it exists) Recent writing blocks.
_Avoid_: landing page, index

**Intro**:
The opening block of the Homepage: name, role line and short bio.
_Avoid_: hero, about, header

**Links**:
The row of contact and profile links (GitHub, LinkedIn, email) in the header on every page.
_Avoid_: socials, footer links

**Project**:
A piece of Josh's work shown on the Homepage, with a title, one-line description and one public link (on this site, as for a Game, or elsewhere). Something without a public link is not a Project.
_Avoid_: portfolio item, work, repo

**Post**:
A single piece of writing published under `/writing`. A long-form write-up about a Project is a Post that links to the Project, not a page of the Project.
_Avoid_: article, blog entry

**Game**:
A Project you play in the browser, served from this site at `/games/<name>/`. Its page is the game alone, full screen, with no header or yellow column. The game's code lives in `public/games/<name>/`, and its own tests in `tests/<name>/`.
_Avoid_: cart, app, demo

**Tag**:
A short topic label on a Project or a Post (e.g. "Rust", "AI"), shown as a chip. Projects set them in `projects.json`, Posts in their frontmatter.
_Avoid_: category, label

**Draft**:
A Post that isn't published yet. It can be seen while writing and reviewing, but never on the live site, in the feed or in Recent writing. A Draft is unlisted, not secret: anyone can read its source, so writing that must stay private isn't a Draft yet.
_Avoid_: unpublished post, WIP

**Recent writing**:
The Homepage block listing the latest three Posts. It doesn't exist until the first Post does.
_Avoid_: blog section, latest posts

**View**:
One browser visit to a Post, or to a Game's page, on the live site. Crawlers, previews and local runs don't count, and Josh's own Views (from a browser marked with `/writing/?me`) are logged but not counted. A Post's View count is shown in its header once it has one. Each View's source is its `?ref=` tag, else the site that linked to it, else direct.
_Avoid_: hit, pageview, read count

**Play**:
One run of a Game started: in Twenty Boats, a Draw (Draw a passenger, Draw again) or Live this night again. One View can lead to many Plays. A Play's source is that of the page's View. Only the live site records them, and Josh's are logged but flagged, like his Views.
_Avoid_: session, game start, run (in counts)

**Finish**:
A Play that reached its Ending. Each Finish records which Ending, and whether the passenger lived.
_Avoid_: completion, win, game over

**Like**:
A reader's thumbs-up on a Post, given with the button at the end of it. Each browser can Like a Post once; there is no unlike. Only the live site records them.
_Avoid_: upvote, heart, favourite

**Interest**:
A reader's answer to "Would you subscribe by email if I set it up?" at the end of a Post. It measures whether an email list is worth building. No address is collected. Each browser can answer once across all Posts, and only the live site records it.
_Avoid_: signup, subscriber, lead
