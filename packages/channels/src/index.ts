export {
  CHANNEL_CAPABILITIES, type CapabilitySet, type ChannelKey, type InboundEvent,
  type ChannelAccountRef, type SendInput, type SendResult, type PublishInput,
  type AdapterHealth, type ChannelAdapter,
} from "./types";
export { PlaceholderAdapter, registerAdapter, getAdapter, listAdapters } from "./registry";
