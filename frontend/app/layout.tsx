import './global.css'

import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import type { ReactNode } from 'react'
import ReactScan from './(landing)/react-scan'

const inter = Inter({
  subsets: ['latin'],
})

export const metadata = {
  title: 'Marble OS',
  description: 'UI Experiment for Vision OS',
  metadataBase: new URL(process.env.NEXT_PUBLIC_URL || 'http://localhost:3080'),
} satisfies Metadata

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <ReactScan />
      <body className="flex min-h-screen flex-col">{children}</body>
    </html>
  )
}
