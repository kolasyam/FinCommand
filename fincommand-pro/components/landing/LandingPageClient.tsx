'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LandingLoginModal } from './LandingLoginModal';
import { getStoredUser, clearSession, type StoredUser } from '@/lib/dashboard/api-client';

const FEATURES = [
  { title: 'IND AS Schedule III', desc: 'Balance Sheet, P&L, and Notes to Accounts computed to Schedule III of the Companies Act, from a single Trial Balance upload.' },
  { title: 'Live Zoho Books sync', desc: 'Connect Zoho Books once and let scheduled syncs keep every report current, with a full sync audit trail.' },
  { title: 'Board-ready exports', desc: 'One-click Excel and PDF exports for every report, plus a consolidated Annual Report pack.' },
  { title: 'Role-based access', desc: 'Admin, CFO, CEO, Auditor, Manager and Viewer roles with per-endpoint authorization and a full audit log.' },
  { title: 'Scenario planning', desc: 'Model revenue growth and cost changes against real actuals before they hit the board deck.' },
  { title: 'Multi-year comparatives', desc: 'Three-year trend views with YoY growth and CAGR, computed from the same engine as every other report.' },
];

export default function LandingPageClient() {
  const searchParams = useSearchParams();
  const [loginOpen, setLoginOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<StoredUser | null>(null);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);

  useEffect(() => {
    if (searchParams.get('auth') === 'login') setLoginOpen(true);
    setCurrentUser(getStoredUser());
  }, [searchParams]);

  return (
    <div style={{ background: '#0b1220', color: '#e5e7eb', minHeight: '100vh' }}>
      <style>{`
        .profile-dropdown-container {
          position: relative;
          display: inline-block;
        }
        .profile-dropdown-menu {
          position: absolute;
          top: 100%;
          right: 0;
          margin-top: 10px;
          z-index: 100;
          width: 250px;
          background: #0f1826;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 12px;
          padding: 16px;
          box-shadow: 0 15px 30px rgba(0,0,0,0.6);
          display: flex;
          flex-direction: column;
          gap: 12px;
          opacity: 0;
          transform: translateY(8px) scale(0.96);
          visibility: hidden;
          transition: opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1), transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), visibility 0.25s;
          transition-delay: 0.15s;
        }
        .profile-dropdown-container:hover .profile-dropdown-menu {
          opacity: 1;
          transform: translateY(0) scale(1);
          visibility: visible;
          transition-delay: 0.2s; /* Apply hover entry delay */
        }
        /* Bridge to prevent closing when moving mouse to dropdown */
        .profile-dropdown-menu::before {
          content: '';
          position: absolute;
          top: -15px;
          right: 0;
          width: 100%;
          height: 15px;
        }
      `}</style>

      <LandingLoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />

      {logoutConfirmOpen && (
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
          background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div style={{
            background: '#0f1826', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 12, padding: 24, width: 360, textAlign: 'center',
            boxShadow: '0 20px 40px rgba(0,0,0,0.5)'
          }}>
            <h3 style={{ fontSize: 18, fontWeight: 600, color: '#fff', marginTop: 0, marginBottom: 12 }}>Confirm Sign Out</h3>
            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 24 }}>Are you sure you want to log out of your session?</p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button
                onClick={() => setLogoutConfirmOpen(false)}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)',
                  background: 'transparent', color: '#e5e7eb', fontSize: 13, cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  clearSession();
                  setCurrentUser(null);
                  setLogoutConfirmOpen(false);
                }}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: 'none',
                  background: '#ef4444', color: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600
                }}
              >
                Log Out
              </button>
            </div>
          </div>
        </div>
      )}

      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 32px', maxWidth: 1200, margin: '0 auto', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>
          FinCommand Pro <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: 'rgba(15,110,86,.25)', color: '#5DCAA5', marginLeft: 8, fontWeight: 500 }}>IND AS · Schedule III</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {currentUser ? (
            <div className="profile-dropdown-container">
              <button
                type="button"
                style={{
                  width: 38, height: 38, borderRadius: '50%', background: '#185fa5',
                  color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 16, fontWeight: 700, textTransform: 'uppercase', border: 'none',
                  cursor: 'pointer', outline: 'none'
                }}
              >
                {currentUser.name.slice(0, 1)}
              </button>

              <div className="profile-dropdown-menu">
                <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
                  <span style={{ fontSize: 14, color: '#fff', fontWeight: 600 }}>{currentUser.name}</span>
                  <span style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{currentUser.role.toUpperCase()} · {currentUser.company_name}</span>
                </div>
                
                <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />

                <Link
                  href="/dashboard"
                  style={{
                    fontSize: 13, padding: '10px 12px', borderRadius: 6, background: '#185fa5',
                    color: '#fff', textDecoration: 'none', fontWeight: 600, textAlign: 'center',
                    display: 'block'
                  }}
                >
                  Go to Dashboard
                </Link>

                {currentUser.role === 'admin' && (
                  <Link
                    href="/dashboard/company-overview"
                    style={{
                      fontSize: 13, padding: '10px 12px', borderRadius: 6, background: 'transparent',
                      color: '#e5e7eb', border: '1px solid rgba(255,255,255,0.15)', textDecoration: 'none',
                      fontWeight: 500, textAlign: 'center', display: 'block'
                    }}
                  >
                    🏢 Company Overview
                  </Link>
                )}

                <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />

                <button
                  type="button"
                  onClick={() => {
                    setLogoutConfirmOpen(true);
                  }}
                  style={{
                    fontSize: 13, padding: '10px 12px', borderRadius: 6, background: 'transparent',
                    color: '#ef4444', border: '1px solid rgba(239,68,68,0.25)', fontWeight: 600,
                    cursor: 'pointer', width: '100%', textAlign: 'center'
                  }}
                >
                  Logout
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                onClick={() => setLoginOpen(true)}
                style={{ fontSize: 13, padding: '8px 16px', borderRadius: 6, background: 'transparent', color: '#e5e7eb', border: '1px solid rgba(255,255,255,.15)', fontWeight: 500, cursor: 'pointer' }}
              >
                Sign In
              </button>
              <Link href="/signup" style={{ fontSize: 13, padding: '8px 16px', borderRadius: 6, background: '#185fa5', color: '#fff', textDecoration: 'none', fontWeight: 600 }}>
                Register Company
              </Link>
            </>
          )}
        </div>
      </header>

      <main style={{ maxWidth: 1000, margin: '0 auto', padding: '64px 32px 40px', textAlign: 'center' }}>
        <div style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: '#5DCAA5', marginBottom: 16, fontWeight: 600 }}>
          CFO / CEO Financial Command Center
        </div>
        <h1 style={{ fontSize: 44, lineHeight: 1.15, fontWeight: 700, color: '#fff', marginBottom: 20 }}>
          One Trial Balance upload.<br />Every board-ready financial statement.
        </h1>
        <p style={{ fontSize: 16, color: '#9ca3af', maxWidth: 640, margin: '0 auto 36px', lineHeight: 1.6 }}>
          FinCommand Pro turns a monthly Trial Balance — from Excel or Zoho Books — into a live Balance Sheet,
          P&amp;L, Cash Flow, Ratios, and Board Pack, all computed by a single financial engine so every report agrees with every other report.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          {currentUser ? (
            <>
              {currentUser.role === 'admin' && (
                <Link href="/dashboard/company-overview" style={{ fontSize: 14, padding: '12px 28px', borderRadius: 8, background: 'transparent', color: '#e5e7eb', textDecoration: 'none', fontWeight: 500, border: '1px solid rgba(255,255,255,.15)' }}>
                  🏢 Company Overview
                </Link>
              )}
              <Link href="/dashboard" style={{ fontSize: 14, padding: '12px 32px', borderRadius: 8, background: '#185fa5', color: '#fff', textDecoration: 'none', fontWeight: 600 }}>
                Go to Dashboard →
              </Link>
            </>
          ) : (
            <>
              <Link href="/signup" style={{ fontSize: 14, padding: '12px 28px', borderRadius: 8, background: '#185fa5', color: '#fff', textDecoration: 'none', fontWeight: 600 }}>
                Register Company
              </Link>
              <Link href="/dashboard" style={{ fontSize: 14, padding: '12px 28px', borderRadius: 8, background: 'transparent', color: '#e5e7eb', textDecoration: 'none', fontWeight: 500, border: '1px solid rgba(255,255,255,.15)' }}>
                Explore with Sample Data
              </Link>
            </>
          )}
        </div>
      </main>

      <section id="features" style={{ maxWidth: 1100, margin: '0 auto', padding: '40px 32px 80px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
          {FEATURES.map(f => (
            <div key={f.title} style={{ background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)', borderRadius: 12, padding: 22 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#fff', marginBottom: 8 }}>{f.title}</div>
              <div style={{ fontSize: 13, color: '#9ca3af', lineHeight: 1.6 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      <footer style={{ borderTop: '1px solid rgba(255,255,255,.08)', padding: '24px 32px', textAlign: 'center', fontSize: 12, color: '#6b7280' }}>
        FinCommand Pro — built on Next.js, PostgreSQL (Neon), and a single-source-of-truth financial engine.
      </footer>
    </div>
  );
}
