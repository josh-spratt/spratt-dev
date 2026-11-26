# A first-party Visitor cookie, not a cookie-free hash

We want rolling daily, weekly and monthly active Visitors (DAU, WAU, MAU) for free, so the Worker gives each browser a random, anonymous id in an `HttpOnly` first-party cookie that lasts about 400 days, and every Event records it. A cookie-free hash of IP and user agent with a rotating salt (Plausible's approach) was the more private default, but a daily salt can't give WAU or MAU, and a monthly salt breaks at month boundaries and counts phones that change IP several times. To limit what the id adds up to, no IP is ever stored, Visitor ids are stripped from Events older than 13 months, and a public "How this site counts visits" page says all of this.

## Consequences

- Under EU rules an analytics cookie may need consent; a cookie-free hash wouldn't. If that becomes a problem, this is the decision to revisit.
- One person on two devices is two Visitors.
