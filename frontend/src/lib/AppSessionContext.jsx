import { createContext, useContext } from 'react'

const AppSessionContext = createContext(null)

export function AppSessionProvider({ value, children }) {
  return (
    <AppSessionContext.Provider value={value}>
      {children}
    </AppSessionContext.Provider>
  )
}

export function useAppSession() {
  const context = useContext(AppSessionContext)
  if (!context) {
    throw new Error('useAppSession must be used within an AppSessionProvider.')
  }
  return context
}
