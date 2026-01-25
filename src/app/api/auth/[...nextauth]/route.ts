import NextAuth from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createLogger } from '@/utils/logger';

const logger = createLogger('api/auth/[...nextauth]');

export const authOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials.password) {
          logger.warn('Authorization attempt with missing credentials.');
          return null;
        }

        try {
          const [rows] = await executeRawQuery('SELECT id, username, password_hash FROM users WHERE username = ?', [credentials.username]);
          const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

          if (!user) {
            logger.warn('Authorization attempt with unknown username:', { username: credentials.username });
            return null;
          }

          const isPasswordValid = await bcrypt.compare(credentials.password, user.password_hash);

          if (!isPasswordValid) {
            logger.warn('Authorization attempt with invalid password for user:', { username: credentials.username });
            return null;
          }

          logger.info('User authorized successfully:', { userId: user.id, username: user.username });
          // Return user object, NextAuth will automatically create a session
          return {
            id: user.id.toString(), // Auth.js expects string IDs
            name: user.username,
            // You can add other user properties here if needed for the session
          };
        } catch (error: unknown) {
          logger.error('Database error during authorization:', error instanceof Error ? error : String(error));
          return null;
        }
      },
    }),
  ],
  session: {
    jwt: true, // Use JWT for session management
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  callbacks: {
    async jwt({ token, user }: { token: any, user: any }) {
      if (user) {
        token.id = user.id;
        token.name = user.name;
      }
      return token;
    },
    async session({ session, token }: { session: any, token: any }) {
      session.user.id = token.id;
      return session;
    },
  },
  pages: {
    signIn: '/login', // Specify custom login page
    // signOut: '/auth/signout',
    // error: '/auth/error', // Error code passed in query string as ?error=
    // verifyRequest: '/auth/verify-request', // (used for email provider)
    // newUser: '/auth/new-user' // New users will be directed here on first sign in (only if using a database adapter)
  },
  secret: process.env.NEXTAUTH_SECRET, // Environment variable for JWT encryption
};

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
