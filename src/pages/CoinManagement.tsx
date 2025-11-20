import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Coins, Plus, Trash2 } from "lucide-react";
import { getUsers, creditCoins, createUser, deleteUser } from "@/services/api";

interface User {
  id: number;
  email: string;
  role: string;
  coins: number;
}

const CoinManagement = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [amount, setAmount] = useState("");
  const [crediting, setCrediting] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<'user' | 'admin'>("user");
  const [newCoins, setNewCoins] = useState("0");
  const [newPassword, setNewPassword] = useState("");
  const [creatingUser, setCreatingUser] = useState(false);
  const [deletingUsers, setDeletingUsers] = useState<Set<number>>(new Set());

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      setLoading(true);
      const userList = await getUsers();
      setUsers(userList);
    } catch (err: any) {
      setError(err.message || "Failed to load users");
    } finally {
      setLoading(false);
    }
  };

  const handleCredit = async () => {
    if (!selectedUser || !amount) return;

    try {
      setCrediting(true);
      setError("");
      setSuccess("");

      await creditCoins(selectedUser.id, parseInt(amount));
      setSuccess(`Successfully credited ${amount} coins to ${selectedUser.email}`);
      setAmount("");
      setSelectedUser(null);
      loadUsers(); // Refresh the list
    } catch (err: any) {
      setError(err.message || "Failed to credit coins");
    } finally {
      setCrediting(false);
    }
  };

  const handleDeleteUser = async (userId: number, userEmail: string) => {
    if (!confirm(`Are you sure you want to delete user ${userEmail}? This action cannot be undone.`)) {
      return;
    }

    try {
      setDeletingUsers(prev => new Set([...prev, userId]));
      setError("");
      setSuccess("");

      await deleteUser(userId);
      setSuccess(`Successfully deleted user ${userEmail}`);
      loadUsers(); // Refresh the list
    } catch (err: any) {
      setError(err.message || "Failed to delete user");
    } finally {
      setDeletingUsers(prev => {
        const newSet = new Set(prev);
        newSet.delete(userId);
        return newSet;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Coin Management</h1>
          <p className="text-muted-foreground">
            Manage user coin balances and credit additional coins
          </p>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert>
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Coins className="h-5 w-5" />
              Credit Coins
            </CardTitle>
            <CardDescription>
              Add coins to a user's account
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="user">Select User</Label>
              <select
                id="user"
                className="w-full px-3 py-2 border border-input bg-background rounded-md"
                value={selectedUser?.id || ""}
                onChange={(e) => {
                  const user = users.find(u => u.id === parseInt(e.target.value));
                  setSelectedUser(user || null);
                }}
              >
                <option value="">Choose a user...</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.email} (Current: {user.coins} coins)
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">Amount</Label>
              <Input
                id="amount"
                type="number"
                placeholder="Enter amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                min="1"
              />
            </div>

            <Button
              onClick={handleCredit}
              disabled={!selectedUser || !amount || crediting}
              className="w-full"
            >
              {crediting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <Plus className="mr-2 h-4 w-4" />
              Credit Coins
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" /> Create User
            </CardTitle>
            <CardDescription>Create a new user with initial coins</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Email</Label>
                <Input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="user@example.com" />
              </div>
              <div>
                <Label>Username</Label>
                <Input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="username" />
              </div>
              <div>
                <Label>Role</Label>
                <select className="w-full px-3 py-2 border border-input bg-background rounded-md" value={newRole} onChange={(e) => setNewRole(e.target.value as any)}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <Label>Initial Coins</Label>
                <Input type="number" value={newCoins} onChange={(e) => setNewCoins(e.target.value)} min="0" />
              </div>
              <div>
                <Label>Initial Password (optional)</Label>
                <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Set a password" />
              </div>
            </div>
            <Button
              onClick={async () => {
                try {
                  setCreatingUser(true);
                  await createUser({ email: newEmail, username: newUsername, role: newRole, coins: parseInt(newCoins || '0'), password: newPassword || undefined });
                  setNewEmail(""); setNewUsername(""); setNewCoins("0"); setNewRole('user'); setNewPassword("");
                  await loadUsers();
                  setSuccess("User created successfully");
                } catch (err: any) {
                  setError(err.message || 'Failed to create user');
                } finally {
                  setCreatingUser(false);
                }
              }}
              disabled={creatingUser || !newEmail || !newUsername}
              className="w-full"
            >
              {creatingUser && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create User
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Users Overview</CardTitle>
            <CardDescription>
              Current coin balances for all users
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {users.map((user) => (
                <div key={user.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="font-medium">{user.email}</p>
                    <p className="text-sm text-muted-foreground">ID: {user.id}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="font-semibold">{user.coins} coins</p>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDeleteUser(user.id, user.email)}
                      disabled={deletingUsers.has(user.id)}
                    >
                      {deletingUsers.has(user.id) ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Users</CardTitle>
          <CardDescription>
            Detailed view of all user accounts
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Coins</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>{user.id}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>{user.role}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {user.coins}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDeleteUser(user.id, user.email)}
                      disabled={deletingUsers.has(user.id)}
                    >
                      {deletingUsers.has(user.id) ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
};

export default CoinManagement;
