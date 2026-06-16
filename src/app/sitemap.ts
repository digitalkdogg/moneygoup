import { MetadataRoute } from 'next'
import { SITE_URL as siteUrl } from '@/utils/siteUrl'

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl,
      lastModified: new Date('2026-05-25'),
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${siteUrl}/login`,
      lastModified: new Date('2026-05-25'),
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: `${siteUrl}/register`,
      lastModified: new Date('2026-05-25'),
      changeFrequency: 'monthly',
      priority: 0.8,
    },
  ]
}
