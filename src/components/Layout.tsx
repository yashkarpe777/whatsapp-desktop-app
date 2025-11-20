import { Outlet, useLocation, Link, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { jwtDecode } from "jwt-decode";
// import of 'api' from services/api
import {
  Play,
  BarChart3,
  Settings,
  Zap,
  Users,
  Activity,
  FileText,
  Coins
} from "lucide-react";

const sidebarItems = [
  {
    title: "Dashboard",
    href: "/app",
    icon: BarChart3,
  },
  {
    title: "Contacts",
    href: "/app/contacts",
    icon: Users,
  },
  {
    title: "Campaigns",
    href: "/app/campaigns",
    icon: Play,
  },
  {
    title: "Active Campaigns",
    href: "/app/campaigns/active",
    icon: Activity,
  },
  {
    title: "Logs",
    href: "/app/logs",
    icon: FileText,
  },
  {
    title: "Settings",
    href: "/app/settings",
    icon: Settings,
  },
  {
    title: "Logout",
    href: "/app/logout",
    icon: Zap,
  },
];

export function Layout() {
  const location = useLocation();

  const token = localStorage.getItem('token');
  let role = null;
  if (token) {
    try {
      const decoded: any = jwtDecode(token);
      role = decoded.role;
    } catch (error) {
      console.error('Invalid token');
    }
  }

  const adminItems = role === 'admin' ? [
    {
      title: "Coin Management",
      href: "/app/coin-management",
      icon: Coins,
    },
  ] : [];

  const allSidebarItems = [...sidebarItems, ...adminItems];

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <div className="hidden md:flex w-64 flex-col bg-card border-r border-border">
        {/* Logo */}
        <div className="flex items-center gap-3 p-6 border-b border-border">
          <div className="w-8 h-8 bg-gradient-primary rounded-lg flex items-center justify-center">
            <Zap className="w-4 h-4 text-primary-foreground" />
          </div>
          <div>
            <h1 className="font-bold text-foreground">WhatsApp Blast</h1>
            <p className="text-xs text-muted-foreground">Business Tool</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4">
          <ul className="space-y-2">
            {allSidebarItems.map((item) => {
const isActive = location.pathname === item.href || location.pathname.startsWith(item.href + "/");
              return (
                <li key={item.href}>
                  <Link
                    to={item.href}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200",
                      isActive
                        ? "bg-gradient-primary text-primary-foreground shadow-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                  >
                    <item.icon className="w-4 h-4" />
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-border">
          <div className="bg-gradient-glass rounded-lg p-3 border border-glass-border backdrop-blur-sm">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 bg-success rounded-full animate-pulse"></div>
              <span className="text-xs font-medium text-foreground">WhatsApp Status</span>
            </div>
            <p className="text-xs text-muted-foreground">Connected & Ready</p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Mobile Header */}
        <div className="md:hidden flex items-center justify-between p-4 border-b border-border bg-card">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gradient-primary rounded-lg flex items-center justify-center">
              <Zap className="w-4 h-4 text-primary-foreground" />
            </div>
            <h1 className="font-bold text-foreground">WhatsApp Blast</h1>
          </div>
        </div>

        {/* Page Content */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
