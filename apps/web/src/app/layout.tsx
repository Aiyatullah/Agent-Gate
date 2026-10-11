import type { Metadata } from 'next';
import { Fraunces, Instrument_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
const sans=Instrument_Sans({subsets:['latin'],variable:'--font-instrument-sans'});const mono=JetBrains_Mono({subsets:['latin'],variable:'--font-jetbrains-mono'});const display=Fraunces({subsets:['latin'],style:['normal','italic'],variable:'--font-fraunces'});
export const metadata:Metadata={title:'AgentGate — Agent control plane',description:'Govern tools, permissions, approvals and traces.'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable}`}><body>{children}</body></html>}
