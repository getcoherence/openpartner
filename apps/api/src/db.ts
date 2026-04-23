import './env.js';
import { createDb } from '@openpartner/db';

export const db = createDb({ connectionString: process.env.DATABASE_URL! });
