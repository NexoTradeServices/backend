// The job-dispatched SMS -- Feature 4002, dispatch to assignment.
// Notifications / Transactional messages ("Job dispatched", Contractor); AC31.
//
// Same facts and link as the email (plan decision 12) -- SMS is for the
// time-sensitive dispatch itself (Notifications / Cadence discipline).
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const TEXT = `New job for you, {{firstName}}. {{trade}}, {{jobReference}}, {{slotLabel}} at {{street}}, {{suburb}}. Accept or decline: {{linkUrl}} -- {{platformName}}`;

export const jobDispatchedSms: NotificationTemplate = {
  type: "job_dispatched",
  channel: "sms",
  category: "transactional",
  render(context) {
    return { text: fill(TEXT, context) };
  },
};
