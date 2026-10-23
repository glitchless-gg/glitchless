import { createContext, useContext } from 'react';

// What a hosting shell may change about the dashboard. Self-hosted Glitchless uses these defaults; a hosted
// service can wrap <App shell={…} /> to rebrand it, add pages and say where its settings live.
export const DEFAULT_SHELL = {
  brand: { logo: './glitchless-icon-64.png', name: 'Glitchless', tagline: 'Game Observability' },
  heroImage: './glitchy-play.png', // the Agents page banner
  emptyImage: './glitchy-search.png', // empty states
  setupLink: { href: '#/setup', label: 'Install Glitchless →' },
  exportersHelp: null, // replaces the server env var instructions on the Agents page
  servicesLabel: null, // a caption over the service picker
  servicesEmpty: 'No games yet',
  className: '',
  boardActions: null, // a component ({ board }) for more buttons on a board, such as the hosted service's Share
};

export const Shell = createContext(DEFAULT_SHELL);
export const useShell = () => useContext(Shell);
