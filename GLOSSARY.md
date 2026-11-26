# jspratt.dev

Josh Spratt's personal homepage: a professional calling card that grows to hold projects and writing.

## Language

**Homepage**:
The single page at `/`, made of the Intro, Recent writing (once it exists), Games and Projects blocks.
_Avoid_: landing page, index

**Intro**:
The opening block of the Homepage: name, role line and short bio.
_Avoid_: hero, about, header

**Links**:
The row of contact and profile links (GitHub, LinkedIn, email) in the header on every page.
_Avoid_: socials, footer links

**Project**:
A piece of Josh's code or work shown in the Homepage's Projects block, with a title, one-line description and one public link, usually elsewhere (e.g. its repo). Something without a public link is not a Project. A Game is not a Project: it's listed with the Games. Projects are set in `projects.json`.
_Avoid_: portfolio item, work, repo

**Post**:
A single piece of writing published under `/writing`. A long-form write-up about a Project is a Post that links to the Project, not a page of the Project.
_Avoid_: article, blog entry

**Game**:
Something you play in the browser, served from this site at `/games/<name>/`. Its page is the game alone, full screen, with no header or yellow column. The game's code lives in `public/games/<name>/`, and its own tests in `tests/<name>/`. Each Game is listed in `games.json` (title, one-line description, image, Tags) and shown on the Games page and in the Homepage's Games block, not with the Projects.
_Avoid_: cart, app, demo, project (for a Game)

**Games page**:
The page at `/games/` listing every Game, each leading to the Game's own page. It's an ordinary page of the site, with the header, and is linked as Games in the header beside Writing.
_Avoid_: arcade, games index, games hub

**Tag**:
A short topic label on a Project, a Game or a Post (e.g. "Rust", "AI"), shown as a chip. Projects set them in `projects.json`, Games in `games.json`, Posts in their frontmatter.
_Avoid_: category, label

**Draft**:
A Post that isn't published yet. It can be seen while writing and reviewing, but never on the live site, in the feed or in Recent writing. A Draft is unlisted, not secret: anyone can read its source, so writing that must stay private isn't a Draft yet.
_Avoid_: unpublished post, WIP

**Recent writing**:
The Homepage block listing the latest three Posts. It doesn't exist until the first Post does.
_Avoid_: blog section, latest posts

**View**:
One browser visit to any page of the live site: the Homepage, the Games page, the Writing list, a Post or a Game's page. Crawlers, previews and local runs don't count, and Josh's own Views (from any browser he has signed into the private stats page with) are recorded but not counted. A Post's View count is shown in its header once it has one. Each View's source is its `?ref=` tag, else the site that linked to it, else direct.
_Avoid_: hit, pageview, read count

**Play**:
One run of a Game started: in Twenty Boats, a Draw (Draw a passenger, Draw again) or Live this night again; in Cactus Boats, setting sail from the title or Sunk! screen. One View can lead to many Plays. A Play's source is that of the page's View. Only the live site records them, and Josh's are logged but flagged, like his Views.
_Avoid_: session, game start, run (in counts)

**Finish**:
A Play that reached its Ending. Each Finish records which Ending, and whether the passenger lived. In Cactus Boats every Play ends in a Finish: being sunk (Ending `sunk`, not lived), so its Score says more than its Finishes.
_Avoid_: completion, win, game over

**Score**:
The points from one Play of Cactus Boats: points for each second survived plus more for each boat sunk, from `scoreOf` in the game's `score.js`.
_Avoid_: high score, points total

**Leaderboard**:
The top 10 Scores of a Game from everyone who has played it on the live site, kept by the Worker. Previews and local runs show it but never add to it. Josh's Scores are on it too, flagged in the database only.
_Avoid_: high-score table, rankings, hall of fame

**Initials**:
The three letters (A–Z) a player puts against a Score that makes the Leaderboard. The only thing on the board that says who played; the game remembers the last ones used, and they can be skipped.
_Avoid_: name, tag, handle

**Like**:
A reader's thumbs-up on a Post, given with the button at the end of it. Each browser can Like a Post once; there is no unlike. Only the live site records them.
_Avoid_: upvote, heart, favourite

**Interest**:
A reader's answer to "Would you subscribe by email if I set it up?" at the end of a Post. It measures whether an email list is worth building. No address is collected. Each browser can answer once across all Posts, and only the live site records it.
_Avoid_: signup, subscriber, lead

**Event**:
One thing a reader did that the live site records: a View, a Play, a Finish, a Like, an Interest or a Click out. Every Event has the same shape (what happened, on which page, when, its source, its Visitor, and whether it was Josh's) so all of them are counted the same way.
_Avoid_: hit, log entry, metric

**Visitor**:
One browser, recognised across visits for about 400 days by an anonymous id the site gives it. It says nothing about who the person is. Daily, weekly and monthly active Visitors (DAU, WAU, MAU) count distinct Visitors with at least one Event in the last 1, 7 or 30 days. One person on a phone and a laptop is two Visitors.
_Avoid_: user, unique, session

**Click out**:
A reader following a Project's link or one of the Links off the site. Its source is that of the page's View.
_Avoid_: outbound click, exit, referral
