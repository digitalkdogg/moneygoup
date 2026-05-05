describe('Preview Page Components', () => {
  describe('Component Files Exist', () => {
    it('Hero component file exists', () => {
      expect(() => {
        require('../components/Hero');
      }).not.toThrow();
    });

    it('Features component file exists', () => {
      expect(() => {
        require('../components/Features');
      }).not.toThrow();
    });

    it('CTA component file exists', () => {
      expect(() => {
        require('../components/CTA');
      }).not.toThrow();
    });

    it('Footer component file exists', () => {
      expect(() => {
        require('../components/Footer');
      }).not.toThrow();
    });

    it('ContactForm component file exists', () => {
      expect(() => {
        require('../components/ContactForm');
      }).not.toThrow();
    });
  });

  describe('Component Exports', () => {
    it('Hero exports default function', () => {
      const Hero = require('../components/Hero').default;
      expect(typeof Hero).toBe('function');
    });

    it('Features exports default function', () => {
      const Features = require('../components/Features').default;
      expect(typeof Features).toBe('function');
    });

    it('CTA exports default function', () => {
      const CTA = require('../components/CTA').default;
      expect(typeof CTA).toBe('function');
    });

    it('Footer exports default function', () => {
      const Footer = require('../components/Footer').default;
      expect(typeof Footer).toBe('function');
    });

    it('ContactForm exports default function', () => {
      const ContactForm = require('../components/ContactForm').default;
      expect(typeof ContactForm).toBe('function');
    });
  });

  describe('Page File', () => {
    it('Preview page file exists', () => {
      expect(() => {
        require('../page');
      }).not.toThrow();
    });

    it('Preview page exports default component', () => {
      const { default: PreviewPage } = require('../page');
      expect(typeof PreviewPage).toBe('function');
    });

    it('Preview page exports metadata', () => {
      const { metadata } = require('../page');
      expect(metadata).toBeDefined();
    });

    it('Metadata has title', () => {
      const { metadata } = require('../page');
      expect(metadata.title).toBeDefined();
      expect(metadata.title).toContain('GrowMyStock');
    });

    it('Metadata has description', () => {
      const { metadata } = require('../page');
      expect(metadata.description).toBeDefined();
      expect(metadata.description.length).toBeGreaterThan(0);
    });

    it('Metadata has Open Graph tags', () => {
      const { metadata } = require('../page');
      expect(metadata.openGraph).toBeDefined();
      expect(metadata.openGraph.title).toBeDefined();
      expect(metadata.openGraph.description).toBeDefined();
      expect(metadata.openGraph.type).toBe('website');
    });

    it('Metadata has Twitter tags', () => {
      const { metadata } = require('../page');
      expect(metadata.twitter).toBeDefined();
      expect(metadata.twitter.card).toBe('summary_large_image');
    });
  });

  describe('Component Structure', () => {
    it('Hero file contains section element', () => {
      const fs = require('fs');
      const path = require('path');
      const heroPath = path.join(__dirname, '../components/Hero.tsx');
      const content = fs.readFileSync(heroPath, 'utf-8');
      expect(content).toContain('<section');
      expect(content).toContain('AI-Powered Stock Analysis');
    });

    it('Features file contains 6 features', () => {
      const fs = require('fs');
      const path = require('path');
      const featuresPath = path.join(__dirname, '../components/Features.tsx');
      const content = fs.readFileSync(featuresPath, 'utf-8');
      expect(content).toContain('AI-Driven Predictions');
      expect(content).toContain('Real-Time Market Data');
      expect(content).toContain('Portfolio Tracking');
      expect(content).toContain('Watchlist Management');
    });

    it('Features file uses article elements', () => {
      const fs = require('fs');
      const path = require('path');
      const featuresPath = path.join(__dirname, '../components/Features.tsx');
      const content = fs.readFileSync(featuresPath, 'utf-8');
      expect(content).toContain('<article');
    });

    it('ContactForm file is client component', () => {
      const fs = require('fs');
      const path = require('path');
      const formPath = path.join(__dirname, '../components/ContactForm.tsx');
      const content = fs.readFileSync(formPath, 'utf-8');
      expect(content).toContain("'use client'");
    });

    it('Footer file contains footer element', () => {
      const fs = require('fs');
      const path = require('path');
      const footerPath = path.join(__dirname, '../components/Footer.tsx');
      const content = fs.readFileSync(footerPath, 'utf-8');
      expect(content).toContain('<footer');
    });
  });

  describe('Accessibility Features', () => {
    it('Components use semantic HTML', () => {
      const fs = require('fs');
      const path = require('path');

      const heroPath = path.join(__dirname, '../components/Hero.tsx');
      const heroContent = fs.readFileSync(heroPath, 'utf-8');
      expect(heroContent).toContain('<h1');

      const featuresPath = path.join(__dirname, '../components/Features.tsx');
      const featuresContent = fs.readFileSync(featuresPath, 'utf-8');
      expect(featuresContent).toContain('<h2');
      expect(featuresContent).toContain('<h3');
    });

    it('ContactForm has proper label elements', () => {
      const fs = require('fs');
      const path = require('path');
      const formPath = path.join(__dirname, '../components/ContactForm.tsx');
      const content = fs.readFileSync(formPath, 'utf-8');
      expect(content).toContain('<label');
      expect(content).toContain('htmlFor');
    });

    it('Components have focus states', () => {
      const fs = require('fs');
      const path = require('path');

      const heroPath = path.join(__dirname, '../components/Hero.tsx');
      const heroContent = fs.readFileSync(heroPath, 'utf-8');
      expect(heroContent).toContain('focus:');

      const formPath = path.join(__dirname, '../components/ContactForm.tsx');
      const formContent = fs.readFileSync(formPath, 'utf-8');
      expect(formContent).toContain('focus:');
    });

    it('ContactForm has ARIA attributes', () => {
      const fs = require('fs');
      const path = require('path');
      const formPath = path.join(__dirname, '../components/ContactForm.tsx');
      const content = fs.readFileSync(formPath, 'utf-8');
      expect(content).toContain('aria-');
    });
  });

  describe('Responsive Design', () => {
    it('Components use Tailwind responsive prefixes', () => {
      const fs = require('fs');
      const path = require('path');

      const heroPath = path.join(__dirname, '../components/Hero.tsx');
      const heroContent = fs.readFileSync(heroPath, 'utf-8');
      expect(heroContent).toMatch(/sm:|lg:|md:/);

      const featuresPath = path.join(__dirname, '../components/Features.tsx');
      const featuresContent = fs.readFileSync(featuresPath, 'utf-8');
      expect(featuresContent).toMatch(/grid-cols-1|sm:|lg:/);
    });

    it('Components have mobile-first approach', () => {
      const fs = require('fs');
      const path = require('path');

      const heroPath = path.join(__dirname, '../components/Hero.tsx');
      const heroContent = fs.readFileSync(heroPath, 'utf-8');
      // Base styles for mobile, then sm:, lg: for larger screens
      expect(heroContent).toContain('sm:');
      expect(heroContent).toContain('lg:');
    });

    it('Features component has responsive grid', () => {
      const fs = require('fs');
      const path = require('path');
      const featuresPath = path.join(__dirname, '../components/Features.tsx');
      const content = fs.readFileSync(featuresPath, 'utf-8');
      expect(content).toContain('grid-cols-1');
      expect(content).toContain('md:grid-cols-2');
      expect(content).toContain('lg:grid-cols-3');
    });
  });
});
