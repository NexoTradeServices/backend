// The "Contractor agreement updated" email -- Feature 2006, contractor
// agreement acceptance.
//
// Notifications / Contractor messages (agreement updated), transactional:
// account mail to a contractor's login, always sends, no unsubscribe. Says
// there is a new version, what it means until he accepts (no new job can be
// sent, booked jobs go ahead), and that he reads it in his own time.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{name}},

Version {{version}} of the contractor agreement is ready for you to read and accept.

Until you accept it, no new jobs can be sent to you. Jobs you have already booked go ahead as normal.

Read it in your own time - it also waits on your dashboard:

{{agreementUrl}}

-- {{platformName}}`;

const HTML = `<p>Hi {{name}},</p>
<p>Version {{version}} of the contractor agreement is ready for you to read and accept.</p>
<p>Until you accept it, no new jobs can be sent to you. Jobs you have already booked go ahead as normal.</p>
<p>Read it in your own time - it also waits on your dashboard.</p>
<p><a href="{{agreementUrl}}">Read and accept</a></p>
<p>-- {{platformName}}</p>`;

export const contractorAgreementUpdatedEmail: NotificationTemplate = {
  type: "contractor_agreement_updated",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: fill("Contractor agreement updated - {{platformName}}", context),
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
