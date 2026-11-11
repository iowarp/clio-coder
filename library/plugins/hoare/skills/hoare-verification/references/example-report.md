# Worked example: binary search in C

This is a complete report for a small function with one real defect. Use it as a
model of depth and tone: every passing obligation has a reason, the one failure has
a concrete traced input, and the inferred clauses and assumptions are stated. It is
an illustration written by hand, not a recorded run.

Code under review, `src/search.c`:

```c
 1  /* Returns an index i with a[i] == key, or -1 if key is not in a.
 2     a must be sorted in nondecreasing order. */
 3  int bsearch_int(const int *a, int n, int key) {
 4      int lo = 0, hi = n - 1;
 5      while (lo <= hi) {
 6          int mid = (lo + hi) / 2;
 7          if (a[mid] < key) lo = mid + 1;
 8          else if (a[mid] > key) hi = mid - 1;
 9          else return mid;
10      }
11      return -1;
12  }
```

## Markdown report

```markdown
# Correctness report: src/search.c:bsearch_int

Verdict: fail. Requested assurance: argued. Correctness: total.
Language: C, hazard profile lang-c-cpp.md.
Specification strength: postcondition and sortedness from the doc comment; bounds on n and validity of a inferred.

## Specification
| Target | Clause | Formula | Source |
| --- | --- | --- | --- |
| bsearch_int | pre | ∀j,k. 0 ≤ j ≤ k < n ⇒ a[j] ≤ a[k] | docs L2 |
| bsearch_int | pre | 0 ≤ n ∧ valid_read(a + (0..n-1)) | inferred |
| bsearch_int | post | result = -1 ⇒ ∀k. 0 ≤ k < n ⇒ a[k] ≠ key | docs L1 |
| bsearch_int | post | result ≠ -1 ⇒ 0 ≤ result < n ∧ a[result] = key | docs L1 |
| bsearch_int | frame | assigns nothing | contract (const int *) |

## Annotations
- L5 invariant I: 0 ≤ lo ∧ hi ≤ n-1 ∧ lo ≤ hi+1 ∧ (∀k. 0 ≤ k < n ∧ a[k] = key ⇒ lo ≤ k ≤ hi)
- L5 variant V: hi - lo + 1
- Callees: none.

## Obligations
| Id | Obligation | Status | How |
| --- | --- | --- | --- |
| bsearch_int.L4.int.signed-overflow | n - 1 does not overflow | argued | n ≥ 0 gives n - 1 ≥ -1 |
| bsearch_int.L5.init | lo = 0, hi = n-1 ⇒ I | argued | every k in [0, n) lies in [0, n-1]; 0 ≤ (n-1)+1 |
| bsearch_int.L5.guard | lo <= hi is defined | argued | int comparison is always defined |
| bsearch_int.L5.preserve | I ∧ lo ≤ hi ⇒ wp(body, I) | argued | A1 |
| bsearch_int.L5.exit | I ∧ lo > hi ⇒ post with result = -1 | argued | no k satisfies lo ≤ k ≤ hi, so no a[k] = key |
| bsearch_int.L5.bound | I ∧ lo ≤ hi ⇒ V ≥ 0 | argued | hi - lo + 1 ≥ 1 |
| bsearch_int.L5.decrease | each branch decreases V or exits | argued | lo ≤ mid ≤ hi (A2): lo := mid+1 > lo; hi := mid-1 < hi |
| bsearch_int.L6.int.signed-overflow | lo + hi does not overflow | refuted | C1 |
| bsearch_int.L7.mem.bounds | 0 ≤ mid < n at a[mid] | argued | A2 with 0 ≤ lo and hi ≤ n-1 |
| bsearch_int.L7.int.signed-overflow | mid + 1 does not overflow | argued | mid ≤ n-1 ≤ INT_MAX-1 |
| bsearch_int.L8.int.signed-overflow | mid - 1 does not overflow | argued | mid ≥ 0 |
| bsearch_int.L9.post | a[mid] = key ⇒ post with result = mid | argued | both comparisons false, so a[mid] = key; 0 ≤ mid < n by L7 |

Counts: 11 argued, 1 refuted, 0 unknown.

## Arguments and counterexamples
A1 (preserve). Assume I ∧ lo ≤ hi.
1. Case a[mid] < key, then lo := mid+1. For any k with a[k] = key: if k ≤ mid, sortedness gives a[k] ≤ a[mid] < key, a contradiction, so k ≥ mid+1. The new lo ≤ hi+1 follows from mid ≤ hi.
2. Case a[mid] > key, then hi := mid-1. Symmetrically, k ≥ mid would give a[k] ≥ a[mid] > key, so k ≤ mid-1. The new hi ≤ n-1 and lo ≤ hi+1 follow from lo ≤ mid ≤ hi.
3. Case a[mid] = key: the function returns, so I need not hold. The obligation is L9.

A2 (lo ≤ mid ≤ hi). From 0 ≤ lo ≤ hi, lo + hi ≥ 0, and C's truncating division equals floor for a non-negative dividend. So 2·lo ≤ lo+hi ≤ 2·hi gives lo ≤ ⌊(lo+hi)/2⌋ ≤ hi. This assumes lo + hi was computed without overflow, which C1 refutes, so A2 holds only under the proposed fix.

C1 (refuted). Take n = INT_MAX = 2³¹−1, a[k] = k (sorted), key = INT_MAX. The key is larger than every element, so the a[mid] < key branch runs each iteration and hi stays at 2³¹−2. Iteration 1: lo = 0, mid = 2³⁰−1. Iteration 2: lo = 2³⁰, and lo + hi = 3·2³⁰ − 2 > INT_MAX. That is signed overflow at L6, which is undefined behavior. The input is about 8 GiB of int: large, but within the precondition, which does not bound n.

## Limitations and assumptions
- assumed: no concurrent writes to a during the call.
- inferred: the pre clauses 0 ≤ n and valid_read(a + (0..n-1)). If callers may pass n < 0, the loop does not run and -1 still meets the post, but the spec should say so.
- No prover check is declared, so no obligation can be above argued.

## Proposed annotations and checks
- Fix L6: int mid = lo + (hi - lo) / 2; here 0 ≤ hi - lo ≤ n-1 cannot overflow, and A2 then needs no overflow assumption.
- ACSL contract, with I and V above as loop invariant and loop variant:
  requires 0 <= n && \valid_read(a + (0 .. n-1));
  requires \forall integer j, k; 0 <= j <= k < n ==> a[j] <= a[k];
  assigns \nothing;
  ensures \result != -1 ==> 0 <= \result < n && a[\result] == key;
  ensures \result == -1 ==> \forall integer k; 0 <= k < n ==> a[k] != key;
- verifiers.yaml entry: {id: "wp:bsearch-int", description: "Frama-C WP proves bsearch_int", command: [python3, tools/wp_all_proved.py, src/search.c], cwd: ., timeoutMs: 300000, tags: [formal, frama-c]}
```

## Worker result

The same review as a `hoare-verifier` result. Routine argued obligations are
shortened here. A real result keeps one check per obligation.

```json
{"verdict":"fail","checks":[
  {"name":"scope","passed":true,"evidence":"targets src/search.c:bsearch_int (C, lang-c-cpp.md); total; assurance argued; post and sortedness from docs L1-2, bounds on n and validity of a inferred"},
  {"name":"bsearch_int.spec","passed":true,"evidence":"pre: sorted [docs L2]; 0≤n ∧ valid_read(a+(0..n-1)) [inferred]; post: result=-1 ⇒ key absent, else 0≤result<n ∧ a[result]=key [docs L1]; frame: assigns nothing [contract const]"},
  {"name":"bsearch_int.L5.init","passed":true,"evidence":"argued | lo=0, hi=n-1 ⇒ I | every k in [0,n) lies in [0,n-1]; 0 ≤ (n-1)+1"},
  {"name":"bsearch_int.L5.preserve","passed":true,"evidence":"argued | I ∧ lo≤hi ⇒ wp(body,I) | 1) a[mid]<key: k≤mid ⇒ a[k]≤a[mid]<key, so k≥mid+1; 2) a[mid]>key: symmetric, k≤mid-1; 3) a[mid]=key returns (L9)"},
  {"name":"bsearch_int.L5.exit","passed":true,"evidence":"argued | I ∧ lo>hi ⇒ post(-1) | no k with lo≤k≤hi, so no a[k]=key"},
  {"name":"bsearch_int.L5.decrease","passed":true,"evidence":"argued | V = hi-lo+1 decreases | lo≤mid≤hi (A2, under the L6 fix): lo:=mid+1 > lo, hi:=mid-1 < hi"},
  {"name":"bsearch_int.L6.int.signed-overflow","passed":false,"evidence":"refuted | lo+hi ≤ INT_MAX | n=INT_MAX, a[k]=k, key=INT_MAX: iteration 2 has lo=2^30, hi=2^31-2, lo+hi=3·2^30-2 > INT_MAX, UB | fix: mid = lo + (hi-lo)/2"},
  {"name":"bsearch_int.L7.mem.bounds","passed":true,"evidence":"argued | 0≤mid<n | A2 with 0≤lo and hi≤n-1"},
  {"name":"bsearch_int.L9.post","passed":true,"evidence":"argued | a[mid]=key ⇒ post(mid) | both comparisons false, so a[mid]=key; 0≤mid<n by L7"},
  {"name":"limitations","passed":true,"evidence":"assumed: no concurrent writes to a; inferred: 0≤n and validity of a; no prover declared, so max status argued"}
]}
```
