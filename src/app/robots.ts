import { MetadataRoute } from 'next'
import { SITE_URL as siteUrl } from '@/utils/siteUrl'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        // Search bots: only index the public marketing/auth pages
        userAgent: ['Googlebot', 'Bingbot', 'Slurp', 'DuckDuckBot', 'Baiduspider', 'YandexBot'],
        allow: ['/', '/login', '/register', '/legal/'],
        disallow: [
          '/dashboard',
          '/portfolio',
          '/profile',
          '/search',
          '/admin',
          '/api/',
          '/contact',
          '/forgot-password',
          '/reset-password',
        ],
      },
      {
        // Social bots: allow all public pages so OG tags can be read for link previews
        userAgent: ['facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'WhatsApp', 'Slackbot', 'Discordbot'],
        allow: '/',
        disallow: '/api/',
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  }
}
