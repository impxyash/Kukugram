import { z } from "zod";

export const accountRoles = ["user", "creator", "moderator", "admin", "support"] as const;
export const accountRoleSchema = z.enum(accountRoles);
export type AccountRole = z.infer<typeof accountRoleSchema>;

export const privacyModes = ["public", "private", "restricted_creator"] as const;
export const privacyModeSchema = z.enum(privacyModes);
export type PrivacyMode = z.infer<typeof privacyModeSchema>;

export const handleSchema = z
  .string()
  .min(3)
  .max(30)
  .regex(/^[a-z0-9_]+$/, "Handles use lowercase letters, numbers, and underscores only.");

export const registrationSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(128),
  dateOfBirth: z.string().date()
});
export type RegistrationInput = z.infer<typeof registrationSchema>;

export const createProfileSchema = z.object({
  handle: handleSchema,
  displayName: z.string().trim().min(1).max(60),
  bio: z.string().trim().max(500).optional(),
  privacy: privacyModeSchema.default("public")
});
export type CreateProfileInput = z.infer<typeof createProfileSchema>;

export function normalizeHandle(handle: string): string {
  return handle.trim().toLocaleLowerCase("en-US");
}
