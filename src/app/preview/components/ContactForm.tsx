'use client';

import { useState } from 'react';

interface FormData {
  name: string;
  email: string;
  company: string;
  message: string;
  website?: string; // Honeypot field - should remain empty
}

interface FormStatus {
  type: 'idle' | 'loading' | 'success' | 'error';
  message: string;
}

export default function ContactForm() {
  const [formData, setFormData] = useState<FormData>({
    name: '',
    email: '',
    company: '',
    message: '',
  });

  const [status, setStatus] = useState<FormStatus>({
    type: 'idle',
    message: '',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus({ type: 'loading', message: 'Submitting...' });

    try {
      const response = await fetch('/api/preview/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to submit form');
      }

      setStatus({
        type: 'success',
        message: 'Thank you! We\'ll be in touch soon.',
      });
      setFormData({ name: '', email: '', company: '', message: '' });

      setTimeout(() => {
        setStatus({ type: 'idle', message: '' });
      }, 5000);
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'An error occurred. Please try again.',
      });
    }
  };

  return (
    <section id="contact" className="w-full py-20 sm:py-24 lg:py-32 px-4 sm:px-6 lg:px-8 bg-white">
      <div className="max-w-2xl mx-auto">
        <div className="text-center space-y-4 mb-12 sm:mb-16">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900">
            Get Early Access
          </h2>
          <p className="text-lg text-gray-600">
            Join our waitlist and be among the first to experience AI-powered stock analysis.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-gray-50 rounded-lg shadow-md p-8 sm:p-10 space-y-6"
          noValidate
          aria-label="Early access request form"
        >
          {/* Honeypot field - hidden from users */}
          <input
            type="text"
            name="website"
            value={formData.website || ''}
            onChange={handleChange}
            style={{ display: 'none' }}
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
          />
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-2">
              Full Name <span className="text-red-600" aria-label="required">*</span>
            </label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              required
              aria-required="true"
              aria-describedby="name-hint"
              className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500 transition-colors"
              placeholder="John Doe"
            />
            <p id="name-hint" className="text-xs text-gray-500 mt-1">Your full name</p>
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
              Email Address <span className="text-red-600" aria-label="required">*</span>
            </label>
            <input
              type="email"
              id="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              required
              aria-required="true"
              aria-describedby="email-hint"
              className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500 transition-colors"
              placeholder="john@example.com"
            />
            <p id="email-hint" className="text-xs text-gray-500 mt-1">We'll use this to contact you</p>
          </div>

          <div>
            <label htmlFor="company" className="block text-sm font-medium text-gray-700 mb-2">
              Company <span className="text-gray-500">(optional)</span>
            </label>
            <input
              type="text"
              id="company"
              name="company"
              value={formData.company}
              onChange={handleChange}
              className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500 transition-colors"
              placeholder="Your company"
            />
          </div>

          <div>
            <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-2">
              Message <span className="text-red-600" aria-label="required">*</span>
            </label>
            <textarea
              id="message"
              name="message"
              value={formData.message}
              onChange={handleChange}
              required
              aria-required="true"
              aria-describedby="message-hint"
              rows={5}
              className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500 transition-colors resize-none"
              placeholder="Tell us about your investment interests and goals..."
            />
            <p id="message-hint" className="text-xs text-gray-500 mt-1">Help us understand your needs (minimum 1 character)</p>
          </div>

          {status.type === 'success' && (
            <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-green-800 font-medium" role="status" aria-live="polite">
                ✓ {status.message}
              </p>
            </div>
          )}

          {status.type === 'error' && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-800 font-medium" role="alert" aria-live="polite">
                ✗ {status.message}
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={status.type === 'loading'}
            aria-busy={status.type === 'loading'}
            className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-4 px-6 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 min-h-12 text-base"
          >
            {status.type === 'loading' ? 'Submitting...' : 'Request Access'}
          </button>

          <p className="text-xs text-gray-500 text-center">
            We respect your privacy. We'll never share your information.
          </p>
        </form>
      </div>
    </section>
  );
}
