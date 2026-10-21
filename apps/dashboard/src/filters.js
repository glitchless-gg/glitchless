import { createContext, useContext } from 'react';

export const Filters = createContext(null);
export const useFilters = () => useContext(Filters);
