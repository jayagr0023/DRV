import { type ReactNode, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import DryRun from '@/pages/DryRun';
import DesignReview from '@/pages/DesignReview';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
export type ThemeChoice = 'light' | 'dark' | 'system';

function Router() {
  const [theme, setTheme] = useState<ThemeChoice>(() => {
    const saved = localStorage.getItem('dryrun-theme');
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
  });

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    media.addEventListener('change', apply);
    localStorage.setItem('dryrun-theme', theme);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  const sharedProps = { theme, setTheme };
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/"><DryRun {...sharedProps} /></Route>
        <Route path="/design"><DesignReview {...sharedProps} /></Route>
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;