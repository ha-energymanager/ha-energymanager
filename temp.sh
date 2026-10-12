for b in test early; do
  git checkout --orphan $b
  git rm -rf .
  git commit --allow-empty -m "Initialise $b branch"
  git push -u origin $b
done
git checkout development
