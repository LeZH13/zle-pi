import { describe, expect, it } from "vitest";
import { RISKY_RULES, compilePatterns, findRisky } from "../src/rules.js";

const BASE = { rules: RISKY_RULES, extra: [], allow: [] };

function ids(command: string): string[] {
	return findRisky(command, BASE).matches.map((match) => match.ruleId);
}

describe("rules: risky detection", () => {
	it("flags rm with recursive/force flags and globs", () => {
		expect(ids("rm -rf /tmp/build")).toContain("rm-recursive-force-glob");
		expect(ids("rm -r build")).toContain("rm-recursive-force-glob");
		expect(ids("rm -fr build")).toContain("rm-recursive-force-glob");
		expect(ids("rm --recursive dir")).toContain("rm-recursive-force-glob");
		expect(ids("rm --force one-file")).toContain("rm-recursive-force-glob");
		expect(ids("rm *.log")).toContain("rm-recursive-force-glob");
		expect(ids("rm build/*.o")).toContain("rm-recursive-force-glob");
		expect(ids("/bin/rm -rf /x")).toContain("rm-recursive-force-glob");
	});

	it("does not flag plain rm of concrete files", () => {
		expect(ids("rm file.txt")).toEqual([]);
		expect(ids("rm file1.txt file2.txt")).toEqual([]);
		expect(ids("rm -v file.txt")).toEqual([]);
	});

	it("flags git destructive shapes", () => {
		expect(ids("git reset --hard")).toContain("git-reset-hard");
		expect(ids("git reset --hard HEAD~3")).toContain("git-reset-hard");
		expect(ids("git push --force origin main")).toContain("git-push-force");
		expect(ids("git push -f")).toContain("git-push-force");
		expect(ids("git push --force-with-lease")).toContain("git-push-force");
		expect(ids("git push origin :feature")).toContain("git-push-force");
		expect(ids("git push origin --delete feature")).toContain("git-push-force");
		expect(ids("git clean -fd")).toContain("git-clean-force");
		expect(ids("git clean -dfx")).toContain("git-clean-force");
		expect(ids("git checkout -- file.ts")).toContain("git-checkout-paths");
		expect(ids("git checkout .")).toContain("git-checkout-paths");
		expect(ids("git restore file.ts")).toContain("git-restore-paths");
		expect(ids("git branch -D wip")).toContain("git-branch-force-delete");
		expect(ids("git stash drop")).toContain("git-stash-drop-clear");
		expect(ids("git stash clear")).toContain("git-stash-drop-clear");
	});

	it("does not flag safe git usage", () => {
		expect(ids("git push origin main")).toEqual([]);
		expect(ids("git push --force-with-lease=main:abc origin main")).toContain("git-push-force");
		expect(ids("git reset HEAD~1")).toEqual([]);
		expect(ids("git clean -n")).toEqual([]);
		expect(ids("git checkout main")).toEqual([]);
		expect(ids("git restore --staged file.ts")).toEqual([]);
		expect(ids("git branch -d merged")).toEqual([]);
		expect(ids("git stash list")).toEqual([]);
	});

	it("flags raw disk and deletion tools", () => {
		expect(ids("dd if=img.iso of=/dev/sda")).toContain("dd");
		expect(ids("mkfs.ext4 /dev/sdb1")).toContain("mkfs");
		expect(ids("shred -u secret.txt")).toContain("shred");
		expect(ids("wipefs /dev/sda")).toContain("wipefs");
		expect(ids("truncate -s 0 huge.log")).toContain("truncate");
		expect(ids("find . -name '*.tmp' -delete")).toContain("find-delete-exec-rm");
		expect(ids("find . -exec rm -rf {} ;")).toContain("find-delete-exec-rm");
		expect(ids("find . -name '*.tmp' -execdir rm {} +")).toContain("find-delete-exec-rm");
		expect(ids("find . -name '*.ts'")).toEqual([]);
	});

	it("flags destructive SQL clients", () => {
		expect(ids('psql -c "DROP TABLE users"')).toContain("sql-drop-truncate");
		expect(ids('mysql -e "TRUNCATE users"')).toContain("sql-drop-truncate");
		expect(ids('psql "$DB" -c "DELETE FROM users"')).toContain("sql-delete-no-where");
		expect(ids('sqlite3 app.db "DROP TABLE users"')).toContain("sqlite-destructive");
		expect(ids('sqlite3 app.db "DELETE FROM users"')).toContain("sqlite-destructive");
		expect(ids('psql -c "DELETE FROM users WHERE id = 1"')).not.toContain("sql-delete-no-where");
		expect(ids('psql -c "SELECT * FROM users"')).toEqual([]);
		expect(ids('sqlite3 app.db ".tables"')).toEqual([]);
	});

	it("flags infra and container destruction", () => {
		expect(ids("terraform destroy")).toContain("terraform-destroy");
		expect(ids("terraform apply -auto-approve")).toContain("terraform-apply-auto-approve");
		expect(ids("kubectl delete pods")).toContain("kubectl-delete");
		expect(ids("docker rm web")).toContain("docker-rm");
		expect(ids("docker rmi img:1")).toContain("docker-rm");
		expect(ids("docker volume rm data")).toContain("docker-volume-rm");
		expect(ids("docker system prune -af")).toContain("docker-system-prune");
		expect(ids("terraform plan")).toEqual([]);
		expect(ids("kubectl get pods")).toEqual([]);
		expect(ids("docker ps")).toEqual([]);
	});

	it("flags recursive permission changes and ecosystem deletions", () => {
		expect(ids("chmod -R 777 /srv")).toContain("chmod-recursive");
		expect(ids("chown -R user:group /srv")).toContain("chown-recursive");
		expect(ids("chmod +x deploy.sh")).toEqual([]);
		expect(ids("npm unpublish pkg@1.0.0")).toContain("npm-unpublish");
		expect(ids("gh repo delete owner/name")).toContain("gh-repo-delete");
		expect(ids("aws s3 rm s3://bucket --recursive")).toContain("aws-s3-rm-recursive");
		expect(ids("aws s3 rb s3://bucket")).toContain("aws-s3-rb");
		expect(ids("aws s3 ls")).toEqual([]);
	});

	it("handles compound commands", () => {
		expect(ids("echo hi && rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
		expect(ids("npm test || git reset --hard")).toContain("git-reset-hard");
		expect(ids("cd /srv; mkfs.ext4 /dev/sdb1")).toContain("mkfs");
		expect(ids("cat log | git push --force origin main")).toContain("git-push-force");
		expect(ids("sleep 5 & kubectl delete pods")).toContain("kubectl-delete");
	});

	it("handles quoting and newlines", () => {
		expect(ids("bash -c 'rm -rf /nowhere'")).toContain("rm-recursive-force-glob");
		expect(ids('sh -c "rm -rf /nowhere"')).toContain("rm-recursive-force-glob");
		expect(ids("eval 'rm -rf /nowhere'")).toContain("rm-recursive-force-glob");
		expect(ids("git add -A\ngit reset --hard")).toContain("git-reset-hard");
	});

	it("recurses into command substitution and backticks", () => {
		expect(ids("echo $(rm -rf /nowhere)")).toContain("rm-recursive-force-glob");
		expect(ids("echo `git reset --hard`")).toContain("git-reset-hard");
		expect(ids("xargs -I{} bash -c 'rm -rf {}'")).toContain("rm-recursive-force-glob");
		expect(ids("echo $(ls)")).toEqual([]);
	});
});

describe("rules: substitution extraction (regressions)", () => {
	it("extracts command substitutions inside double quotes", () => {
		expect(ids('echo "$(rm -rf /tmp/x)"')).toContain("rm-recursive-force-glob");
		expect(ids('echo "pre $(git reset --hard) post"')).toContain("git-reset-hard");
	});

	it("leaves single-quoted substitutions alone", () => {
		expect(ids("echo 'literal $(rm x)'")).toEqual([]);
		expect(ids("echo 'pre `git reset --hard` post'")).toEqual([]);
	});

	it("extracts backticks inside double quotes", () => {
		expect(ids('echo "pre `git reset --hard` post"')).toContain("git-reset-hard");
	});

	it("preserves separators inside subshell groups", () => {
		expect(ids("(echo hi; rm -rf /tmp/x)")).toContain("rm-recursive-force-glob");
		expect(ids("(git push --force && echo done)")).toContain("git-push-force");
		expect(ids("echo a$(echo b; rm -rf /z)c")).toContain("rm-recursive-force-glob");
	});
});

describe("rules: normalization (regressions)", () => {
	it("unwraps sudo and friends", () => {
		expect(ids("sudo rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
		expect(ids("sudo -u root rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
		expect(ids("doas rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
		expect(ids("nohup git push --force")).toContain("git-push-force");
		expect(ids("time rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
		expect(ids("nice rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
		expect(ids("nice -n 5 rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
		expect(ids("exec rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
		expect(ids("xargs rm -rf")).toContain("rm-recursive-force-glob");
		expect(ids("xargs -I{} bash -c 'rm -rf {}'")).toContain("rm-recursive-force-glob");
	});

	it("does not unwrap command -v queries", () => {
		expect(ids("command -v docker")).toEqual([]);
	});

	it("strips leading env assignments", () => {
		expect(ids("X=1 rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
		expect(ids("X=1 Y=2 sudo rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
		expect(ids("env VAR=1 rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
		expect(ids("env -u FOO rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
	});

	it("handles timeout wrappers", () => {
		expect(ids("timeout 10 rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
		expect(ids("timeout 10m rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
		expect(ids("timeout --preserve-status 10 rm -rf /tmp/x")).toContain("rm-recursive-force-glob");
	});

	it("strips git global options", () => {
		expect(ids("git -C /tmp reset --hard")).toContain("git-reset-hard");
		expect(ids("git -c core.x=y push --force origin main")).toContain("git-push-force");
		expect(ids("git --git-dir=/tmp/.git reset --hard")).toContain("git-reset-hard");
		expect(ids("git --work-tree /tmp restore .")).toContain("git-restore-paths");
	});

	it("matches shell option clusters containing c", () => {
		expect(ids('bash -lc "rm -rf /tmp/x"')).toContain("rm-recursive-force-glob");
		expect(ids("sh -ec 'git reset --hard'")).toContain("git-reset-hard");
		expect(ids("bash -x -c 'rm -rf /tmp/x'")).toContain("rm-recursive-force-glob");
	});

	it("strips control keywords", () => {
		expect(ids("if true; then rm -rf /tmp/x; fi")).toContain("rm-recursive-force-glob");
		expect(ids("while true; do kubectl delete pods; done")).toContain("kubectl-delete");
		expect(ids("! git push --force")).toContain("git-push-force");
		expect(ids("{ rm -rf /x; }")).toContain("rm-recursive-force-glob");
		expect(ids("for f in *; do rm -rf $f; done")).toContain("rm-recursive-force-glob");
	});

	it("does not treat shell file arguments as scripts", () => {
		expect(ids("bash script.sh")).toEqual([]);
		expect(ids("bash -e deploy.sh")).toEqual([]);
	});
});

describe("rules: false positives", () => {
	it("quoted destructive text is not a command", () => {
		expect(ids('echo "rm -rf /"')).toEqual([]);
		expect(ids("echo 'git reset --hard'")).toEqual([]);
		expect(ids('grep "rm -rf" notes.txt')).toEqual([]);
	});

	it("quoted globs are literals, not patterns", () => {
		expect(ids("rm 'literal*file'")).toEqual([]);
		expect(ids('rm "literal?file"')).toEqual([]);
		expect(ids("rm *.log")).toContain("rm-recursive-force-glob");
		expect(ids("rm build/*.o")).toContain("rm-recursive-force-glob");
	});

	it("git clean dry runs are not risky", () => {
		expect(ids("git clean -n")).toEqual([]);
		expect(ids("git clean -nf")).toEqual([]);
		expect(ids("git clean -nd")).toEqual([]);
		expect(ids("git clean --dry-run")).toEqual([]);
		expect(ids("git clean -fd")).toContain("git-clean-force");
		expect(ids("git clean -f")).toContain("git-clean-force");
		expect(ids("git clean -dfx")).toContain("git-clean-force");
	});

	it("destructive words as arguments of other tools", () => {
		expect(ids("man rm")).toEqual([]);
		expect(ids("echo dd")).toEqual([]);
		expect(ids("node -e 'console.log(\"rm -rf x\")'")).toEqual([]);
	});
});

describe("rules: user patterns", () => {
	it("extra risky patterns match the full command", () => {
		const extra = compilePatterns(["^make\\s+publish"]);
		const result = findRisky("make publish", { rules: RISKY_RULES, extra, allow: [] });
		expect(result.matches.map((m) => m.ruleId)).toContain("user-pattern");
		expect(findRisky("make build", { rules: RISKY_RULES, extra, allow: [] }).matches).toEqual([]);
	});

	it("allow patterns win over built-in risky rules", () => {
		const allow = compilePatterns(["^rm -rf /tmp/"]);
		expect(findRisky("rm -rf /tmp/cache", { rules: RISKY_RULES, extra: [], allow }).allowed).toBe(true);
		expect(findRisky("rm -rf /tmp/cache", { rules: RISKY_RULES, extra: [], allow }).matches).toEqual([]);
		expect(findRisky("rm -rf /home", { rules: RISKY_RULES, extra: [], allow }).matches).toHaveLength(1);
	});
});

describe("rules: pattern compilation", () => {
	it("skips invalid regexes and reports them", () => {
		const errors: string[] = [];
		const compiled = compilePatterns(["ok.*", "([bad"], (source) => errors.push(source));
		expect(compiled).toHaveLength(1);
		expect(errors).toEqual(["([bad"]);
	});
});
