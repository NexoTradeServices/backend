// The review request -- Feature 6009, ratings and reviews.
// Notifications / Customer messages (Review request); Ratings & Reviews.
//
// To the CUSTOMER, once per job, after her invoice is paid (or at completion of a goodwill callback).
// Five tappable stars: each opens the one review link with that score chosen (`?rating=1` to `?rating=5`).
// The tradie is named by first name; never the word "contractor"; no money.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

Your {{trade}} job {{jobReference}} is finished.

How did {{tradieFirstName}} go?

5 stars: {{linkUrl}}?rating=5
4 stars: {{linkUrl}}?rating=4
3 stars: {{linkUrl}}?rating=3
2 stars: {{linkUrl}}?rating=2
1 star: {{linkUrl}}?rating=1

Tap a star to rate the visit. It takes a minute.

Something not right? Call us on {{officePhone}} and we will sort it out.

-- {{platformName}}`;

const STAR = (n: number) =>
  `<a href="{{linkUrl}}?rating=${String(n)}" title="${String(n)} star${n === 1 ? "" : "s"}" style="text-decoration:none;color:#e8762d;font-size:32px;padding:0 4px">&#9733;</a>`;

const HTML = `<p>Hi {{firstName}},</p>
<p>Your {{trade}} job {{jobReference}} is finished.</p>
<p><strong>How did {{tradieFirstName}} go?</strong></p>
<p>${[1, 2, 3, 4, 5].map(STAR).join("")}</p>
<p>Tap a star to rate the visit. It takes a minute.</p>
<p>Something not right? Call us on {{officePhone}} and we will sort it out.</p>
<p>-- {{platformName}}</p>`;

export const reviewRequestEmail: NotificationTemplate = {
  type: "review_request",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `How did we go? - ${String(context["jobReference"] ?? "")}`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
