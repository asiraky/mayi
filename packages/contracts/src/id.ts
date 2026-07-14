import { customAlphabet } from "nanoid";
import { z } from "zod";

export const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const ID_LENGTH = 12;
export const ID_PATTERN = /^[A-Za-z]{12}$/;

export const Id = z.string().regex(ID_PATTERN, "ID must contain exactly 12 ASCII letters");
export type Id = z.infer<typeof Id>;

export const createId = customAlphabet(ID_ALPHABET, ID_LENGTH);
