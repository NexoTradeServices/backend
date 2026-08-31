// The channel components -- Feature 1004, notification module.
import type { ChannelComponent, NotificationChannel } from "../types.js";
import { emailChannel } from "./email.js";
import { smsChannel } from "./sms.js";

const CHANNELS: Record<NotificationChannel, ChannelComponent> = {
  email: emailChannel,
  sms: smsChannel,
};

export function channelFor(channel: NotificationChannel): ChannelComponent {
  return CHANNELS[channel];
}
