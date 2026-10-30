#!/usr/bin/env python3
"""Provision an administrator or named employee account OFFLINE in a stopped test instance.
The password is entered securely (or piped on stdin) and never appears in arguments/history.
"""
import argparse, getpass, glob, hashlib, os, secrets, sqlite3, sys
parser=argparse.ArgumentParser(description="Create or reset resursplanering user credentials")
parser.add_argument("--data-dir", default="/var/lib/resursplanering-test-excel/data")
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
password=sys.stdin.readline().rstrip("\n") if args.password_stdin else getpass.getpass("New password (12+ chars): ")
if len(password)<12 or len(password)>256:sys.exit("Password must be 12–256 characters")
email=args.email.lower().strip()
db=sqlite3.connect(dbs[0],timeout=10)
db.execute("PRAGMA foreign_keys=ON")
row=db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='user_accounts'").fetchone()
if not row:sys.exit("Run database migration 0009 before provisioning accounts")
employee_id=None
if args.employee_email:
 row=db.execute("SELECT id FROM employees WHERE lower(email)=lower(?)",(args.employee_email.strip().lower(),)).fetchone()
 if not row:sys.exit("Employee not found: "+args.employee_email)
 employee_id=row[0]
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
