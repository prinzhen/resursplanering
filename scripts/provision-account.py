#!/usr/bin/env python3
"""Create or recover a login for any selfhosted D1 instance while its service is stopped.
The password is entered securely (or piped on stdin) and never appears in arguments/history.
Always make a backup first. Never remove the final active administrator.
"""
import argparse, getpass, glob, hashlib, os, secrets, sqlite3, sys
parser=argparse.ArgumentParser(description="Create or reset resursplanering user credentials")
parser.add_argument("--data-dir", required=True, help="DATA_DIR of the STOPPED instance (for example /var/lib/resursplanering-test-access/data)")
parser.add_argument("--email",required=True)
parser.add_argument("--employee-email",help="Link the login to an existing employee")
parser.add_argument("--admin",action="store_true",help="Grant full administrator access")
parser.add_argument("--group-manager",action="store_true",help="Allow managing direct reports and their TEAMs")
parser.add_argument("--password-stdin",action="store_true",help="Read password from standard input")
args=parser.parse_args()
dbs=[p for p in glob.glob(args.data_dir+"/v3/d1/**/*.sqlite",recursive=True)
     if not p.endswith("/metadata.sqlite")]
if len(dbs)!=1:
 sys.exit(f"Expected one D1 database, found {len(dbs)} in {args.data_dir}")
if not args.admin and not args.employee_email:
 sys.exit("Non-admin account needs --employee-email")
password=sys.stdin.readline().rstrip("\n") if args.password_stdin else getpass.getpass("New password (6+ chars): ")
if len(password)<6 or len(password)>256:sys.exit("Password must be 6–256 characters")
email=args.email.lower().strip()
if not email or "@" not in email or len(email)>254:sys.exit("Valid --email is required")
db=sqlite3.connect(dbs[0],timeout=10)
db.execute("PRAGMA foreign_keys=ON")
row=db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='user_accounts'").fetchone()
if not row:sys.exit("Run database migration 0009 before provisioning accounts")
employee_id=None
if args.employee_email:
 row=db.execute("SELECT id FROM employees WHERE lower(email)=lower(?)",(args.employee_email.strip().lower(),)).fetchone()
 if not row:sys.exit("Employee not found: "+args.employee_email)
 employee_id=row[0]
# Preserve existing account/person links when repairing a password or admin role.
# An administrator IS allowed to be a regular employee with assignments.
existing=db.execute("SELECT id,employee_id,is_admin,is_disabled FROM user_accounts WHERE lower(email)=lower(?)",(email,)).fetchone()
if not args.employee_email:
 row=db.execute("SELECT id FROM employees WHERE lower(email)=lower(?)",(email,)).fetchone()
 employee_id=(row[0] if row else (existing[1] if existing else None))
if employee_id is not None:
 owner=db.execute("SELECT id,email FROM user_accounts WHERE employee_id=?",(employee_id,)).fetchone()
 if owner and (not existing or owner[0]!=existing[0]):
  sys.exit("Employee is already linked to another login: "+owner[1])
if existing and existing[2] and not existing[3] and not args.admin:
 others=db.execute("SELECT COUNT(*) FROM user_accounts WHERE is_admin=1 AND is_disabled=0 AND id<>?",(existing[0],)).fetchone()[0]
 if others==0:sys.exit("Refusing to demote last active administrator")
salt=secrets.token_bytes(16)
digest=hashlib.pbkdf2_hmac("sha256",password.encode("utf-8"),salt,310000,dklen=32)
with db:
 db.execute("""INSERT INTO user_accounts(employee_id,email,password_salt,password_hash,is_admin,is_group_manager)
  VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET
  employee_id=excluded.employee_id,password_salt=excluded.password_salt,password_hash=excluded.password_hash,
  is_admin=excluded.is_admin,is_group_manager=excluded.is_group_manager,is_disabled=0,failed_attempts=0,locked_until=NULL""",
  (employee_id,email,salt.hex(),digest.hex(),int(args.admin),int(args.group_manager)))
 id=db.execute("SELECT id FROM user_accounts WHERE email=?",(email,)).fetchone()[0]
 db.execute("DELETE FROM user_sessions WHERE user_id=?",(id,))
print("Account provisioned:",email,"admin="+str(args.admin),"employee="+str(employee_id),"sessions revoked.")
