/**
 * Images in Network conversations, as the two proxies relay them (the brand's
 * routes/settings.ts, the creator's routes/creator-portal.ts). The Network
 * decides what a file is from its bytes (its images.ts); these match its
 * conversation-attachments.ts. No imports: both proxies load this early.
 */

/** The types the Network accepts and serves conversation images as. */
export const CONVERSATION_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** One image's size cap, the Network's too. */
export const CONVERSATION_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
