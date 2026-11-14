# Worked example: binary search in C

This is a complete report for a small function with one real defect. Use it as a
model of depth and tone: every passing obligation has a reason, the defect has
a concrete traced input, dependent obligations remain unknown, and assumptions are stated. It is
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
| bsearch_int | frame | assigns nothing | inferred intent, checked against the body; const alone is not a frame contract |

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
| bsearch_int.L5.preserve | I ∧ lo ≤ hi ⇒ wp(body, I) | unknown | A1 depends on unestablished midpoint lemma A2 |
| bsearch_int.L5.exit | I ∧ lo > hi ⇒ post with result = -1 | argued | no k satisfies lo ≤ k ≤ hi, so no a[k] = key |
| bsearch_int.L5.bound | I ∧ lo ≤ hi ⇒ V ≥ 0 | argued | hi - lo + 1 ≥ 1 |
| bsearch_int.L5.decrease | each branch decreases V or exits | unknown | requires A2, which fails on current source |
| bsearch_int.L6.int.signed-overflow | lo + hi does not overflow | refuted | C1 |
| bsearch_int.L7.mem.bounds | 0 ≤ mid < n at a[mid] | unknown | requires A2 |
| bsearch_int.L7.int.signed-overflow | mid + 1 does not overflow | unknown | mid bound depends on A2 |
| bsearch_int.L8.int.signed-overflow | mid - 1 does not overflow | unknown | mid bound depends on A2 |
| bsearch_int.L9.post | a[mid] = key ⇒ post with result = mid | unknown | requires established bounds and defined execution |

Counts: 5 argued, 1 refuted, 6 unknown.

## Arguments and counterexamples
A1 (conditional preservation, not established on current source). Assume I ∧ lo ≤ hi and A2.
1. Case a[mid] < key, then lo := mid+1. For any k with a[k] = key: if k ≤ mid, sortedness gives a[k] ≤ a[mid] < key, a contradiction, so k ≥ mid+1. The new lo ≤ hi+1 follows from mid ≤ hi.
2. Case a[mid] > key, then hi := mid-1. Symmetrically, k ≥ mid would give a[k] ≥ a[mid] > key, so k ≤ mid-1. The new hi ≤ n-1 and lo ≤ hi+1 follow from lo ≤ mid ≤ hi.
3. Case a[mid] = key: the function returns, so I need not hold. The obligation is L9.

A2 (lo ≤ mid ≤ hi). From 0 ≤ lo ≤ hi, lo + hi ≥ 0, and C's truncating division equals floor for a non-negative dividend. So 2·lo ≤ lo+hi ≤ 2·hi gives lo ≤ ⌊(lo+hi)/2⌋ ≤ hi. This assumes lo + hi was computed without overflow, which C1 refutes, so A2 holds only under the proposed fix.

C1 (refuted). Take n = INT_MAX = 2³¹−1, a[k] = k (sorted), key = INT_MAX. The key is larger than every element, so the a[mid] < key branch runs each iteration and hi stays at 2³¹−2. Iteration 1: lo = 0, mid = 2³⁰−1. Iteration 2: lo = 2³⁰, and lo + hi = 3·2³⁰ − 2 > INT_MAX. That is signed overflow at L6, which is undefined behavior. The input is about 8 GiB of int: large, but within the precondition, which does not bound n.

## Limitations and assumptions
- assumed: no concurrent writes to a during the call.
- inferred: the pre clauses 0 ≤ n and valid_read(a + (0..n-1)). Negative n is excluded; n=INT_MIN would already overflow at n-1.
- No prover check is declared, so no obligation can be above argued.

## Proposed annotations and checks
- Fix L6: int mid = lo + (hi - lo) / 2; here 0 ≤ hi - lo ≤ n-1 cannot overflow, and A2 then needs no overflow assumption.
- ACSL contract, with I and V above as loop invariant and loop variant:
  requires 0 <= n && \valid_read(a + (0 .. n-1));
  requires \forall integer j, k; 0 <= j <= k < n ==> a[j] <= a[k];
  assigns \nothing;
  ensures \result != -1 ==> 0 <= \result < n && a[\result] == key;
  ensures \result == -1 ==> \forall integer k; 0 <= k < n ==> a[k] != key;
- Proposed check: adapt the complete version-2 catalog in provers.md, with exact bsearch_int goals and both src/search.c and the wrapper in proof.inputs. This is not an existing check or proof.
```

## Worker result

Three-obligation excerpt demonstrating the wire format, not a complete review.
A real result includes all twelve obligations above with the corrected statuses.

```json
{"verdict":"fail","assurance":"argued","checks":[
  {"name":"bsearch_int.L5.init","passed":true,"evidence":"Sortedness from docs L2; size/validity inferred; assumes no concurrent writes. Initially every candidate lies in [0,n-1]. No prover ran.",
   "obligation":{"target":"src/search.c:bsearch_int","kind":"init","pre":"sorted readable a[0..n-1], 0 <= n <= INT_MAX; no concurrent writes","post":"valid matching index or -1 iff absent","formula":"lo=0 and hi=n-1 imply I","invariant":"0 <= lo <= hi+1 <= n and every matching index is in [lo,hi]","status":"argued"}},
  {"name":"bsearch_int.L6.int.signed-overflow","passed":false,"evidence":"C1: n=INT_MAX, a[k]=k, key=INT_MAX. Iteration 2: lo=2^30, hi=2^31-2; their sum exceeds INT_MAX, causing UB. Proposed midpoint fix has not been applied.",
   "obligation":{"target":"src/search.c:bsearch_int","kind":"int.signed-overflow","pre":"sorted readable a[0..n-1], 0 <= n <= INT_MAX; no concurrent writes","post":"valid matching index or -1 iff absent","formula":"lo + hi <= INT_MAX","hazard":"int.signed-overflow","status":"refuted"}},
  {"name":"bsearch_int.L7.mem.bounds","passed":false,"evidence":"A2 depends on defined addition, refuted by C1. The proposed source fix cannot justify current-source claims.",
   "obligation":{"target":"src/search.c:bsearch_int","kind":"mem.bounds","pre":"sorted readable a[0..n-1], 0 <= n <= INT_MAX; no concurrent writes","post":"valid matching index or -1 iff absent","formula":"0 <= mid < n","hazard":"mem.bounds","status":"unknown"}}
]}
```
